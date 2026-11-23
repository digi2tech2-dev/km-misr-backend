'use strict';

const fs = require('fs/promises');
const path = require('path');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const { validateUploadedFileSignature } = require('../../shared/middlewares/upload');

const root = path.join(__dirname, '..', '..', '..', 'uploads', 'target-apps');
const chunkBytes = 128 * 1024;
const maxBytes = 20 * 1024 * 1024;
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const uploadChunk = async ({ ownerId, uploadId, index, total, size, mime, data }) => {
    const invalid = () => new BusinessRuleError('Invalid image upload data.', 'TARGET_IMAGE_INVALID');
    if (!/^[a-f0-9]{32}$/.test(String(uploadId)) || !/^[a-f0-9]{24}$/i.test(String(ownerId))) throw invalid();
    if (!Number.isInteger(index) || !Number.isInteger(total) || !Number.isInteger(size) || size < 1 || size > maxBytes || total !== Math.ceil(size / chunkBytes) || index < 0 || index >= total || !extensions[mime]) throw invalid();
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw invalid();
    const bytes = Buffer.from(data, 'base64');
    const expectedSize = index === total - 1 ? size - index * chunkBytes : chunkBytes;
    if (bytes.length !== expectedSize || bytes.toString('base64') !== data) throw invalid();
    const dir = path.join(root, '.chunks', `${ownerId}-${uploadId}`);
    await fs.mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.stringify({ total, size, mime });
    try { await fs.writeFile(manifestPath, manifest, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (await fs.readFile(manifestPath, 'utf8') !== manifest) throw invalid();
    await fs.writeFile(path.join(dir, String(index)), bytes);
    if (index !== total - 1) return { complete: false };

    const parts = [];
    for (let i = 0; i < total; i += 1) {
        const part = await fs.readFile(path.join(dir, String(i))).catch(() => { throw invalid(); });
        if (part.length !== (i === total - 1 ? size - i * chunkBytes : chunkBytes)) throw invalid();
        parts.push(part);
    }
    const buffer = Buffer.concat(parts);
    await validateUploadedFileSignature({ buffer, mimetype: mime });
    const filename = `${ownerId}-${uploadId}.${extensions[mime]}`;
    await fs.writeFile(path.join(root, filename), buffer);
    await fs.rm(dir, { recursive: true, force: true });
    return { complete: true, image: `uploads/target-apps/${filename}` };
};

const discardUpload = async (ownerId, uploadId) => {
    if (!/^[a-f0-9]{32}$/.test(String(uploadId)) || !/^[a-f0-9]{24}$/i.test(String(ownerId))) throw new BusinessRuleError('Invalid image upload data.', 'TARGET_IMAGE_INVALID');
    await fs.rm(path.join(root, '.chunks', `${ownerId}-${uploadId}`), { recursive: true, force: true });
};

module.exports = { uploadChunk, discardUpload, chunkBytes, maxBytes };
