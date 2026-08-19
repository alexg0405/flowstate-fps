import { describe, expect, it } from 'vitest';
import { verifyAssetPayload } from '../src/render/assets/ThreeAssetLoader';

const FLOWSTATE_SHA256 = 'sha256:a689dae869927ec9e11ddd308f8f7af34f247c5d5d816476dcc44ac810d57a44';

describe('asset payload integrity', () => {
  it('accepts bytes matching the catalog length and SHA-256 hash', async () => {
    const bytes = new TextEncoder().encode('flowstate');
    await expect(verifyAssetPayload(bytes.buffer, bytes.byteLength, FLOWSTATE_SHA256)).resolves.toBeUndefined();
  });

  it('rejects an unexpected transfer length before hashing', async () => {
    const bytes = new TextEncoder().encode('flowstate');
    await expect(verifyAssetPayload(bytes.buffer, bytes.byteLength + 1, FLOWSTATE_SHA256))
      .rejects.toThrow(/expected 10 bytes, received 9/u);
  });

  it('rejects content whose digest does not match the catalog', async () => {
    const bytes = new TextEncoder().encode('flowstate!');
    await expect(verifyAssetPayload(bytes.buffer, bytes.byteLength, FLOWSTATE_SHA256))
      .rejects.toThrow(/Asset integrity check failed/u);
  });
});
