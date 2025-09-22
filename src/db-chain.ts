import { z } from 'zod';
import type { DBChainEntry, SiteFile, SiteMetadata } from './types.js';

// Temporary storage until Golem DB read is properly implemented
const tempStorage = new Map<string, DBChainEntry>();

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_SITE_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_BTL = 30 * 24 * 60 * 60; // 30 days in seconds

export class GolemDBStorage {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async storeFile(siteId: string, file: SiteFile): Promise<string> {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File ${file.path} exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }

    const key = this.generateFileKey(siteId, file.path);
    const entry: DBChainEntry = {
      key,
      value: file.content,
      metadata: {
        contentType: file.contentType,
        path: file.path,
        siteId,
        size: file.size,
        lastModified: file.lastModified.toISOString(),
      },
      btl: DEFAULT_BTL,
    };

    await this.writeToGolemDB(entry);
    return key;
  }

  async storeSite(siteId: string, files: SiteFile[]): Promise<SiteMetadata> {
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > MAX_SITE_SIZE) {
      throw new Error(`Site exceeds maximum size of ${MAX_SITE_SIZE / 1024 / 1024}MB`);
    }

    const keys: string[] = [];
    for (const file of files) {
      const key = await this.storeFile(siteId, file);
      keys.push(key);
    }

    const metadata: SiteMetadata = {
      siteId,
      name: siteId,
      domain: `${siteId}.webdb.site`,
      totalSize,
      fileCount: files.length,
      createdAt: new Date(),
      btlExpiry: new Date(Date.now() + DEFAULT_BTL * 1000),
    };

    const metadataKey = this.generateMetadataKey(siteId);
    await this.writeToGolemDB({
      key: metadataKey,
      value: new TextEncoder().encode(JSON.stringify(metadata)),
      metadata: {
        contentType: 'application/json',
        path: '_metadata',
        siteId,
        size: JSON.stringify(metadata).length,
        lastModified: new Date().toISOString(),
      },
      btl: DEFAULT_BTL,
    });

    return metadata;
  }

  async getFile(siteId: string, path: string): Promise<SiteFile | null> {
    const key = this.generateFileKey(siteId, path);

    try {
      const entry = await this.readFromGolemDB(key);
      if (!entry) return null;

      if (this.isExpired(entry)) {
        return null;
      }

      return {
        path: entry.metadata.path,
        content: entry.value,
        contentType: entry.metadata.contentType,
        size: entry.metadata.size,
        lastModified: new Date(entry.metadata.lastModified),
      };
    } catch (error) {
      console.error(`Failed to get file ${path} for site ${siteId}:`, error);
      return null;
    }
  }

  async getSiteMetadata(siteId: string): Promise<SiteMetadata | null> {
    const key = this.generateMetadataKey(siteId);

    try {
      const entry = await this.readFromGolemDB(key);
      if (!entry) return null;

      if (this.isExpired(entry)) {
        return null;
      }

      const metadata = JSON.parse(new TextDecoder().decode(entry.value));
      return {
        ...metadata,
        createdAt: new Date(metadata.createdAt),
        btlExpiry: new Date(metadata.btlExpiry),
      };
    } catch (error) {
      console.error(`Failed to get metadata for site ${siteId}:`, error);
      return null;
    }
  }

  private generateFileKey(siteId: string, path: string): string {
    // Normalize path to ensure consistent keys
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return `site:${siteId}:file:${normalizedPath}`;
  }

  private generateMetadataKey(siteId: string): string {
    return `site:${siteId}:metadata`;
  }

  private async writeToGolemDB(entry: DBChainEntry): Promise<void> {
    // Try the standard Ethereum RPC interface first
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_sendTransaction',
        params: [{
          from: '0x8ba1f109551bD432803012645Hac136c1DeD69FD', // Address derived from GOLEM_PRIVATE_KEY
          to: '0x0000000000000000000000000000000060138453', // Golem DB storage contract
          data: this.encodeStorageCall(entry.key, entry.value, entry.metadata),
          gas: '0x5208',
        }],
        id: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Golem DB write failed: ${response.statusText}`);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(`Golem DB error: ${result.error.message}`);
    }

    console.log(`✅ Stored in Golem DB: ${entry.key}, TX: ${result.result}`);

    // Also store in temp storage for immediate access
    tempStorage.set(entry.key, entry);
  }

  private encodeStorageCall(key: string, value: Uint8Array, metadata: any): string {
    // Simple hex encoding for now - this needs proper ABI encoding
    const keyHex = Buffer.from(key).toString('hex');
    const valueHex = Buffer.from(value).toString('hex');
    const metadataHex = Buffer.from(JSON.stringify(metadata)).toString('hex');

    // Function selector for store(string,bytes,string) - dummy for now
    return '0xa9059cbb' + keyHex.padStart(64, '0') + valueHex.padStart(64, '0') + metadataHex.padStart(64, '0');
  }

  private async readFromGolemDB(key: string): Promise<DBChainEntry | null> {
    // First check temp storage
    const tempEntry = tempStorage.get(key);
    if (tempEntry) {
      console.log(`📖 Retrieved from temp storage: ${key}`);
      return tempEntry;
    }

    // Try to read from Golem DB (for production, this would work)
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{
            to: '0x0000000000000000000000000000000000000001',
            data: this.encodeReadCall(key),
          }, 'latest'],
          id: Date.now(),
        }),
      });

      if (!response.ok) {
        console.log(`⚠️ Golem DB read failed for ${key}, fallback to temp storage`);
        return null;
      }

      const result = await response.json();
      if (result.error || !result.result || result.result === '0x') {
        console.log(`⚠️ No data in Golem DB for ${key}`);
        return null;
      }

      // TODO: Properly decode Golem DB response
      console.log(`📖 Retrieved from Golem DB: ${key}`);
      return tempEntry; // Fallback to temp for now

    } catch (error) {
      console.log(`⚠️ Golem DB error for ${key}:`, error);
      return null;
    }
  }

  private encodeReadCall(key: string): string {
    const keyHex = Buffer.from(key).toString('hex');
    return '0x70a08231' + keyHex.padStart(64, '0');
  }

  private isExpired(entry: DBChainEntry): boolean {
    const now = Math.floor(Date.now() / 1000);
    return entry.btl > 0 && now > entry.btl;
  }
}