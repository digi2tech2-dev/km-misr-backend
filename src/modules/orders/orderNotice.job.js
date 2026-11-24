'use strict';

const { randomUUID } = require('crypto');
const { Order } = require('./order.model');
const { User } = require('../users/user.model');
const whatsapp = require('../whatsapp/whatsapp.service');

const titles = {
    CREATED: '📦 طلب شحن جديد', ACCEPTED: 'تم قبول طلب الشحن', WAITING: 'طلب الشحن قيد الانتظار',
    COMPLETED: 'تم الشحن', FAILED: 'تم رفض طلب الشحن', CANCELED: 'تم إلغاء طلب الشحن',
    PARTIAL: 'تم الشحن جزئيًا',
};
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'PARTIAL']);
const delay = 5 * 60000;
function nextNotice(order, now) {
    const sent = order.waDelivery.sent || [];
    if (!sent.includes('CREATED')) return 'CREATED';
    if (terminal.has(order.status)) return order.status;
    if (order.providerOrderId != null && !sent.includes('ACCEPTED')) return 'ACCEPTED';
    if (!sent.includes('WAITING') && (order.status === 'MANUAL_REVIEW' || now - order.createdAt >= delay)) return 'WAITING';
    return null;
}

function message(order, user, stage) {
    const ref = order.orderNumber || String(order._id);
    const lines = [titles[stage], 'رقم الطلب: ' + ref, 'المنتج: ' + order.waDelivery.product,
        'الكمية: ' + order.quantity, 'الاسم: ' + (user?.name || '—'),
        'البريد الإلكتروني: ' + (user?.email || '—'), 'رقم الهاتف: ' + (user?.phone || '—'),
        'السعر المخصوم: ' + order.chargedAmount + ' ' + order.currency];
    if (stage === 'WAITING') lines.push('كود الانتظار: ' + ref);
    return lines.join('\n');
}

async function deliverOne() {
    const now = new Date();
    const owner = randomUUID();
    const order = await Order.findOneAndUpdate({ 'waDelivery.nextAt': { $lte: now } }, {
        $set: { 'waDelivery.owner': owner, 'waDelivery.nextAt': new Date(+now + 120000) },
    }, { sort: { 'waDelivery.nextAt': 1 }, new: true, timestamps: false }).select('+waDelivery').lean();
    if (!order) return false;
    const filter = { _id: order._id, 'waDelivery.owner': owner };
    const stage = nextNotice(order, now);
    let nextAt = new Date(+now + 30000);
    const update = { $unset: { 'waDelivery.owner': '' } };
    try {
        if (stage) {
            const user = await User.findById(order.userId).select('name email phone').lean();
            await whatsapp.sendAdminNotification(message(order, user, stage));
            update.$addToSet = { 'waDelivery.sent': stage };
            nextAt = terminal.has(stage) ? null : new Date();
        }
    } catch (err) {
        console.warn('[WhatsApp orders] Delivery deferred:', order.orderNumber, err.message);
        nextAt = new Date(+now + 60000);
    }
    if (nextAt) update.$set = { 'waDelivery.nextAt': nextAt };
    else update.$unset['waDelivery.nextAt'] = '';
    await Order.updateOne(filter, update, { timestamps: false });
    return true;
}

function start() {
    let running = false;
    const timer = setInterval(async () => {
        if (running || !whatsapp.getStatus().isConnected) return;
        running = true;
        try {
            for (let i = 0; i < 60 && await deliverOne(); i++) { /* drain due orders */ }
        } catch (err) {
            console.error('[WhatsApp orders]', err.message);
        } finally { running = false; }
    }, 5000);
    timer.unref();
    return () => clearInterval(timer);
}

module.exports = { start, nextNotice, message };
