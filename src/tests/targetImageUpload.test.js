'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { uploadChunk, discardUpload, chunkBytes } = require('../modules/targets/targetImageUpload.service');

describe('target image upload', () => {
    const ownerId = crypto.randomBytes(12).toString('hex');
    let uploadId;
    let outputPath;

    beforeEach(() => { uploadId = crypto.randomBytes(16).toString('hex'); outputPath = null; });
    afterEach(async () => {
        await discardUpload(ownerId, uploadId);
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
    });

    test('reassembles multiple chunks without changing the image', async () => {
        const image = crypto.randomBytes(chunkBytes * 2 + 37);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
        let result;
        for (let index = 0; index < 3; index += 1) {
            result = await uploadChunk({ ownerId, uploadId, index, total: 3, size: image.length, mime: 'image/png', data: image.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64') });
        }
        outputPath = path.join(__dirname, '..', '..', result.image);
        expect(result.complete).toBe(true);
        expect((await fs.readFile(outputPath)).equals(image)).toBe(true);
    });

    test('rejects a file whose contents do not match its type', async () => {
        await expect(uploadChunk({ ownerId, uploadId, index: 0, total: 1, size: 1, mime: 'image/png', data: 'AA==' })).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    });
});
