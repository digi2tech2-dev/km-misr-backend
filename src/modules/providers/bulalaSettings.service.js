'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const { Provider } = require('./provider.model');
const { ProviderProduct } = require('./providerProduct.model');
const { Product, computeFinalPrice } = require('../products/product.model');
const { add, isPositive } = require('../../shared/utils/decimalPrecision');
const { ValidationError, NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const { getNextSequence } = require('../orders/counter.model');

const EXTERNAL_ID = 'ibulala_dynamic_coins';
const isBulala = (p = {}) => {
    const keys = [p.slug, p.name, p.code, p.supplierCode, p.supplierName].map(v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    return keys.some(k => ['coinrecharge', 'bulala', 'ibulala', 'ibulalachat'].includes(k));
};
const isBulalaProviderProduct = async (pp, session = null) => {
    if (pp?.externalProductId !== EXTERNAL_ID || !pp.provider) return false;
    const provider = pp.provider.slug ? pp.provider : await Provider.findById(pp.provider).session(session);
    return Boolean(provider && isBulala(provider));
};
const validateSettings = (input = {}) => {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    let cost;
    try { cost = new Decimal(typeof input.unitCost === 'string' ? input.unitCost : NaN); } catch (_) { /* validated below */ }
    if (name.length < 2 || name.length > 200 || !cost?.isFinite() || !cost.gt(0) || cost.decimalPlaces() > 50 || cost.gte('1e50')) {
        throw new ValidationError('أدخل اسم المنتج وتكلفة موجبة كنص عشري بدقة لا تتجاوز 50 منزلة.');
    }
    const { minQty, maxQty } = input;
    if (!Number.isSafeInteger(minQty) || !Number.isSafeInteger(maxQty) || minQty < 1 || maxQty < minQty) {
        throw new ValidationError('حدود الكمية يجب أن تكون أعدادًا صحيحة موجبة، والحد الأقصى لا يقل عن الأدنى.');
    }
    return { name, unitCost: cost.toFixed(), minQty, maxQty };
};
const getProvider = async (id, session = null) => {
    const provider = await Provider.findById(id).session(session);
    if (!provider) throw new NotFoundError('Provider');
    if (!isBulala(provider) || provider.adapterType && provider.adapterType !== 'dealer-api') {
        throw new ValidationError('هذه الإعدادات متاحة فقط لمورد Bulala باستخدام dealer-api.');
    }
    return provider;
};
const getSettings = async id => {
    await getProvider(id);
    const pp = await ProviderProduct.findOne({ provider: id, externalProductId: EXTERNAL_ID });
    return pp?.adminSettings?.toObject?.() || pp?.adminSettings || null;
};

// Both catalogue layers change atomically. Unique natural keys arbitrate concurrent saves.
const saveSettings = async (id, input, actorId) => {
    const settings = validateSettings(input);
    await getProvider(id);
    // Query upserts do not execute Product's pre-save compatibility-ID hook.
    const compatProductId = await getNextSequence('compatProductId', 999);
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await mongoose.connection.transaction(async session => {
                const provider = await getProvider(id, session);
                if (!provider.isActive) throw new ValidationError('فعّل المورد قبل تجهيز المنتج.');
                const pp = await ProviderProduct.findOneAndUpdate({ provider: id, externalProductId: EXTERNAL_ID }, {
                    $set: { adminSettings: settings, rawName: settings.name, translatedName: settings.name,
                        rawPrice: settings.unitCost, minQty: settings.minQty, maxQty: settings.maxQty, isActive: true },
                }, { upsert: true, new: true, session, runValidators: true });
                const linked = await Product.find({ $or: [{ providerProduct: pp._id }, { provider: id, bulalaDynamicKey: String(id) }] }).session(session);
                if (linked.length > 1) throw new ConflictError('يوجد أكثر من منتج مرتبط. راجع الربط قبل الحفظ.');
                const current = linked[0];
                const price = current?.enableManualPrice
                    ? add(settings.unitCost, current.manualPriceAdjustment || '0')
                    : computeFinalPrice(settings.unitCost, current?.markupType || 'percentage', current?.markupValue || '0');
                if (!isPositive(price)) throw new ValidationError('السعر بعد تعديل هامش الربح يجب أن يكون موجبًا.');
                const productData = { bulalaDynamicKey: String(id), name: settings.name, provider: id, providerProduct: pp._id,
                        providerPrice: settings.unitCost, basePrice: price, finalPrice: price,
                        minQty: settings.minQty, maxQty: settings.maxQty, pricingMode: 'sync', syncPriceWithProvider: true,
                        executionType: 'automatic', isActive: true,
                        orderFields: [{ id: 'bulala_player_id', key: 'player_id', label: 'معرّف اللاعب', type: 'text', required: true, isVerifiable: true }],
                        providerMapping: { player_id: 'toUserId' } };
                // Validate as a document so the shared quantity validator keeps
                // its original behavior for every other supplier's update flow.
                const candidate = new Product({ ...(current?.toObject() || {}), ...productData });
                const validationError = candidate.validateSync();
                if (validationError) throw validationError;
                const product = await Product.findOneAndUpdate(current ? { _id: current._id } : { bulalaDynamicKey: String(id) }, {
                    $set: productData,
                    $setOnInsert: { createdBy: actorId, compatProductId },
                }, { upsert: true, new: true, session });
                result = { settings, productId: product._id, providerProductId: pp._id };
            });
            require('./providerPriceCache').invalidate(String(id));
            return result;
        } catch (error) {
            if (error.code !== 11000 || attempt === 2) throw error;
        }
    }
};

const verifyCheckoutTarget = async (product, values, session = null) => {
    const provider = await getProvider(product.provider, session);
    if (!provider.isActive) throw new ValidationError('مورد Bulala غير نشط.');
    try {
        const { getProviderAdapter } = require('./adapters/adapter.factory');
        await getProviderAdapter(provider, { strict: true }).validateUser(values?.player_id);
    } catch (_) {
        throw new ValidationError('تعذر تأكيد معرّف لاعب Bulala. تحقق من المعرّف وأعد المحاولة.');
    }
};

// All catalogue readers/sync writers use this projection; no placeholder is sellable.
const configuredDto = (pp) => {
    const settings = pp?.adminSettings;
    return settings ? { externalProductId: EXTERNAL_ID, rawName: settings.name, name: settings.name,
        rawPrice: settings.unitCost, price: settings.unitCost, costPrice: settings.unitCost, providerPrice: settings.unitCost,
        minQty: settings.minQty, maxQty: settings.maxQty, isActive: true,
        rawPayload: { product_id: EXTERNAL_ID, product_name: settings.name, product_price: settings.unitCost, currency: 'USD' } } :
        { externalProductId: EXTERNAL_ID, rawName: 'Bulala', rawPrice: '0', price: '0', minQty: 1, maxQty: 1, isActive: false, rawPayload: null };
};

module.exports = { EXTERNAL_ID, isBulala, isBulalaProviderProduct, validateSettings, getSettings, saveSettings, configuredDto, verifyCheckoutTarget };
