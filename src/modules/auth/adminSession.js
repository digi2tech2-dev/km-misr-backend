'use strict';

const mongoose = require('mongoose');
const { AuthenticationError } = require('../../shared/errors/AppError');

const schema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    agent: { type: String, default: '' },
    lastActive: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, expires: 0 },
}, { versionKey: false });

const AdminSession = mongoose.model('AdminSession', schema);

async function activeSession(userId, sid) {
    if (!mongoose.isObjectIdOrHexString(sid)) return null;
    return AdminSession.findOne({ _id: sid, userId, expiresAt: { $gt: new Date() } }).lean();
}

async function requireSession(userId, sid) {
    const session = await activeSession(userId, sid);
    if (!session) throw new AuthenticationError('Please sign in again.');
    if (Date.now() - session.lastActive.getTime() >= 60000) {
        await AdminSession.updateOne({ _id: sid, userId }, { $max: { lastActive: new Date() } });
    }
}

function deviceLabel(agent) {
    const browser = /Edg/i.test(agent) ? 'Edge' : /Firefox|FxiOS/i.test(agent) ? 'Firefox'
        : /Chrome|CriOS/i.test(agent) ? 'Chrome' : /Safari/i.test(agent) ? 'Safari' : '';
    const system = /Android/i.test(agent) ? 'Android' : /iPhone|iPad/i.test(agent) ? 'iOS'
        : /Windows/i.test(agent) ? 'Windows' : /Macintosh/i.test(agent) ? 'macOS'
        : /Linux/i.test(agent) ? 'Linux' : '';
    return [browser, system].filter(Boolean).join(' · ');
}

module.exports = { AdminSession, activeSession, requireSession, deviceLabel };
