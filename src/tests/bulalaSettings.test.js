'use strict';

jest.mock('axios', () => ({ create: jest.fn() }));
const axios = require('axios');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup } = require('./testHelpers');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { createOrder } = require('../modules/orders/order.service');
const { executeOrder, pollProcessingOrders, processOrderStatusResult } = require('../modules/orders/orderFulfillment.service');
const { saveSettings, getSettings, validateSettings } = require('../modules/providers/bulalaSettings.service');
const { ensureDealerDynamicProduct, getProviderProductById } = require('../modules/providers/providerProduct.service');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const { DealerApiAdapter } = require('../modules/providers/adapters/dealerApi.service');

test('admin HTTP persists settings; anonymous/customer/supervisor without product permission are denied', async () => {
    const { createAdmin } = require('./testHelpers');
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const admin = await createAdmin();
    const { customer } = await createCustomerWithGroup({ phone: '+201012345678' });
    const { AdminSession } = require('../modules/auth/adminSession');
    const adminSession = await AdminSession.create({ userId: admin._id, expiresAt: new Date(Date.now() + 600000) });
    const app = require('../app');
    const server = await new Promise(resolve => { const instance = app.listen(0, () => resolve(instance)); });
    const headers = user => ({ Authorization: `Bearer ${jwt.sign({ id: String(user._id), ...(user.role === 'ADMIN' ? { sid: String(adminSession._id) } : {}) }, config.jwt.secret, { expiresIn: '10m' })}`, 'Content-Type': 'application/json' });
    const url = `http://127.0.0.1:${server.address().port}/api/providers/${provider.id}/coin-settings`;
    try {
        expect((await fetch(url)).status).toBe(401);
        expect((await fetch(url, { headers: headers(customer) })).status).toBe(403);
        const empty = await fetch(url, { headers: headers(admin) });
        expect((await empty.json()).data.settings).toBeNull();
        const saved = await fetch(url, { method: 'PUT', headers: headers(admin), body: JSON.stringify(initial) });
        expect(saved.status).toBe(200);
        const loaded = await fetch(url, { headers: headers(admin) });
        expect((await loaded.json()).data.settings).toEqual(initial);
        const invalid = await fetch(url, { method: 'PUT', headers: headers(admin), body: JSON.stringify({ ...initial, unitCost: '0' }) });
        expect(invalid.status).toBe(400);
        const { User } = require('../modules/users/user.model');
        await User.updateOne({ _id: customer._id }, { $set: { role: 'SUPERVISOR', permissions: ['MANAGE_SUPPLIERS'] } });
        const denied = await fetch(url, { method: 'PUT', headers: headers(customer), body: JSON.stringify(initial) });
        expect(denied.status).toBe(403);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('checkout rejects invalid configured quantities before charging wallet', async () => {
    const saved = await saveSettings(provider.id, { ...initial, unitCost: '0.01' });
    const { customer } = await createCustomerWithGroup({ walletBalance: 1000 });
    for (const quantity of [9, 1001, 10.5, '10junk', '1e2', '10.5', '10.0', ' 50 ']) {
        await expect(createOrder({ userId: customer.id, productId: saved.productId, quantity,
            orderFieldsValues: { player_id: '12345' } })).rejects.toThrow();
    }
    const { User } = require('../modules/users/user.model');
    expect((await User.findById(customer.id)).walletBalance).toBe(1000);
    expect(client.post).not.toHaveBeenCalled();
});

const initial = { name: 'Bulala coins', unitCost: '0.00012345678901234567890123456789', minQty: 10, maxQty: 1000 };
let provider;
let client;
beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    provider = await Provider.create({ name: 'Bulala', slug: 'coin-recharge', adapterType: 'dealer-api', baseUrl: 'https://bulala.example.test', apiToken: 'fake' });
    client = { get: jest.fn().mockImplementation(async (_path, options) => ({ data: { code: 200, data: { userId: options.params.userId } } })), post: jest.fn(), interceptors: { response: { use: jest.fn() } } };
    axios.create.mockReturnValue(client);
});

test('unconfigured catalogue is inactive and cannot be sold', async () => {
    expect(await getSettings(provider.id)).toBeNull();
    const pp = await ensureDealerDynamicProduct(provider.id);
    expect(pp.isActive).toBe(false);
    expect((await getProviderProductById(pp.id)).rawPrice).toBe('0');
});

test('save/read/update retains decimal precision, identity and existing markup', async () => {
    const first = await saveSettings(provider.id, initial);
    expect(await getSettings(provider.id)).toEqual(initial);
    await Product.updateOne({ _id: first.productId }, { $set: { markupType: 'percentage', markupValue: '20' } });
    const changed = { ...initial, name: 'New coins', unitCost: '0.000000000123456789012345', minQty: 20, maxQty: 2000 };
    const second = await saveSettings(provider.id, changed);
    expect(String(second.productId)).toBe(String(first.productId));
    const product = await Product.findById(first.productId);
    expect(product.providerPrice).toBe(changed.unitCost);
    expect(product.finalPrice).toBe('0.000000000148148146814814');
    expect(product.minQty).toBe(20);
    expect(product.executionType).toBe('automatic');
    expect(await Product.countDocuments()).toBe(1);
    expect(await ProviderProduct.countDocuments()).toBe(1);
});

test('concurrent saves produce a single product and provider product', async () => {
    await Promise.all(Array.from({ length: 5 }, () => saveSettings(provider.id, initial)));
    expect(await Product.countDocuments()).toBe(1);
    expect(await ProviderProduct.countDocuments()).toBe(1);
});

test.each([
    { unitCost: '0' }, { unitCost: '-1' }, { unitCost: 'NaN' }, { unitCost: 'Infinity' },
    { unitCost: 0.1 }, { unitCost: '1e-51' }, { minQty: 0 }, { minQty: 1.5 },
    { maxQty: 5 }, { maxQty: Number.MAX_SAFE_INTEGER + 1 }, { name: '' },
])('rejects invalid values %j', patch => {
    expect(() => validateSettings({ ...initial, ...patch })).toThrow();
});

test('wrong provider is rejected without writing', async () => {
    provider.slug = 'another-provider'; provider.name = 'Another'; await provider.save();
    await expect(saveSettings(provider.id, initial)).rejects.toThrow();
    expect(await Product.countDocuments()).toBe(0);
});

test('listing, adapter catalogue and sync preserve administrator settings and pricing', async () => {
    const saved = await saveSettings(provider.id, initial);
    await syncProviderProducts(provider.id);
    await ensureDealerDynamicProduct(provider.id);
    expect(await getSettings(provider.id)).toEqual(initial);
    const pp = await getProviderProductById(saved.providerProductId);
    expect(pp.rawName).toBe(initial.name);
    expect(pp.rawPrice).toBe(initial.unitCost);
    expect((await Product.findById(saved.productId)).basePrice).toBe(initial.unitCost);
    expect(client.post).not.toHaveBeenCalled();
});

test('mock sale sends player and chosen quantity; only explicit success completes', async () => {
    await saveSettings(provider.id, initial);
    const adapter = new DealerApiAdapter(provider);
    client.post.mockResolvedValue({ data: { code: 200, data: {} } });
    const result = await adapter.placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: '12345', quantity: 50, referenceId: 'test' });
    expect(result.providerStatus).toBe('Completed');
    expect(client.post).toHaveBeenCalledWith('/dealer/sale', null, expect.objectContaining({ params: { secretKey: 'fake', toUserId: '12345', coins: 50 } }));
    expect((await adapter.checkOrder('unverified')).providerStatus).toBe('Pending');
});

test.each([9, 1001, 10.5, NaN, '1e2', '50.0'])('rejects invalid sale quantity %s without dispatch', async quantity => {
    await saveSettings(provider.id, initial);
    const adapter = new DealerApiAdapter(provider);
    expect((await adapter.placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: 12345, quantity })).success).toBe(false);
    expect(client.post).not.toHaveBeenCalled();
});

test.each([
    () => Promise.reject(new Error('timeout')),
    () => Promise.resolve({ data: { unexpected: true } }),
    () => Promise.resolve({ data: { code: 500 } }),
])('ambiguous dispatch stays uncertain with no fake completion', async outcome => {
    await saveSettings(provider.id, initial);
    const adapter = new DealerApiAdapter(provider);
    client.post.mockImplementation(outcome);
    const result = await adapter.placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: 12345, quantity: 50 });
    expect(result).toMatchObject({ success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' });
});

test('post-send rejection requires reconciliation', async () => {
    await saveSettings(provider.id, initial);
    const adapter = new DealerApiAdapter(provider);
    client.post.mockResolvedValue({ data: { code: 138 } });
    expect(await adapter.placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: 12345, quantity: 50 })).toMatchObject({ requiresManualReview: true, providerStatus: 'PLACEMENT_UNCERTAIN' });
});

test.each([131, 132, 133, 134, 135, 136, 137, 138, 400, 500])('post-sale code %s never triggers an automatic refund', async code => {
    await saveSettings(provider.id, initial);
    client.post.mockResolvedValue({ data: { code, secretKey: 'must-not-be-stored' } });
    const result = await new DealerApiAdapter(provider).placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: '12345', quantity: 50 });
    expect(result).toMatchObject({ requiresManualReview: true, providerOrderId: null });
    expect(JSON.stringify(result)).not.toContain('must-not-be-stored');
    expect(client.post).toHaveBeenCalledTimes(1);
});

test('preserves long target IDs and leading zeros exactly in sale parameters', async () => {
    await saveSettings(provider.id, initial);
    client.post.mockResolvedValue({ data: { code: 200, secretKey: 'must-not-be-stored' } });
    const target = '00123456789012345678901234567890';
    const adapter = new DealerApiAdapter(provider);
    const result = await adapter.placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: target, quantity: 50 });
    expect(client.post.mock.calls[0][2].params.toUserId).toBe(target);
    expect(result.providerOrderId).toBeNull();
    expect(JSON.stringify(result)).not.toContain('must-not-be-stored');
    client.get.mockResolvedValueOnce({ data: { code: 200, data: { userId: target.slice(2) } } });
    expect((await adapter.validateUser(target)).uid).toBe(target.slice(2));
    client.get.mockResolvedValueOnce({ data: { code: 200, data: { userId: '123' } } });
    await expect(adapter.validateUser(target)).rejects.toThrow('different player');
});

test.each([
    () => Promise.reject(new Error('verification timeout')),
    () => Promise.resolve({ data: { code: 200, data: { userId: '99999' } } }),
    () => Promise.resolve({ data: { code: 138 } }),
])('verification failure blocks checkout before wallet debit or sale', async outcome => {
    const saved = await saveSettings(provider.id, { ...initial, unitCost: '0.01' });
    const { customer } = await createCustomerWithGroup({ walletBalance: 1000 });
    client.get.mockImplementation(outcome);
    await expect(createOrder({ userId: customer.id, productId: saved.productId, quantity: 50,
        orderFieldsValues: { player_id: '12345' } })).rejects.toThrow();
    const { User } = require('../modules/users/user.model');
    expect((await User.findById(customer.id)).walletBalance).toBe(1000);
    expect(await Order.countDocuments()).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
});

test.each(['-1', '1e5', '1.5', '+123', '0', 'abc', '1'.repeat(51)])('rejects malformed player ID %s before sending', async target => {
    await saveSettings(provider.id, initial);
    const result = await new DealerApiAdapter(provider).placeOrder({ externalProductId: 'ibulala_dynamic_coins', toUserId: target, quantity: 50 });
    expect(result).toMatchObject({ success: false, definitePreSendFailure: true });
    expect(client.post).not.toHaveBeenCalled();
});

test.each([[200, ORDER_STATUS.COMPLETED, 999.5], [138, ORDER_STATUS.MANUAL_REVIEW, 999.5]])(
    'mock fulfillment code %s follows existing charge/refund rules', async (code, status, balance) => {
        const saved = await saveSettings(provider.id, { ...initial, unitCost: '0.01' });
        const { customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
        client.post.mockResolvedValue({ data: { code } });
        const { order } = await createOrder({ userId: customer.id, productId: saved.productId, quantity: 50,
            orderFieldsValues: { player_id: '12345' } });
        let stored;
        for (let i = 0; i < 100; i++) {
            stored = await Order.findById(order.id);
            const { User } = require('../modules/users/user.model');
            if (stored.status === status && (await User.findById(customer.id)).walletBalance === balance) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(stored.status).toBe(status);
        const { User } = require('../modules/users/user.model');
        expect((await User.findById(customer.id)).walletBalance).toBe(balance);
        await executeOrder(order.id);
        expect(client.post).toHaveBeenCalledTimes(1);
    }
);

test('uncertain fulfillment is never redispatched or refunded and old price stays unchanged', async () => {
    const saved = await saveSettings(provider.id, { ...initial, unitCost: '0.01' });
    const { customer: user } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    client.post.mockRejectedValue(new Error('timeout'));
    const created = await createOrder({ userId: user.id, productId: saved.productId, quantity: 50,
        orderFieldsValues: { player_id: '12345' } });
    const order = created.order || created;
    // createOrder may dispatch asynchronously; the durable claim permits one caller only.
    await executeOrder(order._id);
    for (let i = 0; i < 100 && (await Order.findById(order.id)).status === ORDER_STATUS.PROCESSING; i++) await new Promise(r => setTimeout(r, 10));
    await executeOrder(order._id);
    const before = await Order.findById(order._id);
    expect(before.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
    expect(before.providerStatus).toBe('PLACEMENT_UNCERTAIN');
    expect(client.post).toHaveBeenCalledTimes(1);
    await pollProcessingOrders(new DealerApiAdapter(provider));
    await saveSettings(provider.id, { ...initial, unitCost: '0.02' });
    const after = await Order.findById(order._id);
    expect(after.basePriceSnapshot).toEqual(before.basePriceSnapshot);
    expect(after.refunded).toBe(false);
    expect(client.post).toHaveBeenCalledTimes(1);
    // Legacy orders with a local provider ID also require manual verification,
    // rather than the generic pending retry-limit refund.
    const legacy = await Order.findByIdAndUpdate(order.id, { $set: { status: ORDER_STATUS.PROCESSING } }, { new: true });
    const outcome = await processOrderStatusResult(legacy, await new DealerApiAdapter(provider).checkOrder('local-reference'));
    expect(outcome.action).toBe('manual-review');
    expect((await Order.findById(order.id)).status).toBe(ORDER_STATUS.MANUAL_REVIEW);
});
