import { writeFile, readFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import type { DBChainEntry, SiteFile, SiteMetadata } from './types.js';
import { GolemDBClient } from './golem-db-client.js';

const STORAGE_DIR = '/tmp/webdb-storage';

export class FileStorage {
  private rpcUrl: string;
  private golemDB: GolemDBClient;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.golemDB = new GolemDBClient({
      rpcUrl,
      privateKey: process.env.GOLEM_PRIVATE_KEY || (() => {
        throw new Error('GOLEM_PRIVATE_KEY environment variable is required');
      })()
    });
    this.ensureStorageDir();
  }

  private async ensureStorageDir() {
    try {
      await access(STORAGE_DIR);
    } catch {
      await mkdir(STORAGE_DIR, { recursive: true });
    }
  }

  async storeFile(siteId: string, file: SiteFile): Promise<string> {
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
      btl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days from now
    };

    // Write to Golem DB (logs success/failure)
    const txHash = await this.writeToGolemDB(entry);

    // Always store locally for reliable access
    await this.storeLocally(key, entry);

    console.log(`💾 Stored file: ${key} (${file.size} bytes)`);
    return txHash || key; // Return transaction hash if available, otherwise fallback to key
  }

  async storeSite(siteId: string, files: SiteFile[]): Promise<{
    metadata: SiteMetadata;
    files: Array<{ path: string; size: number; key: string; txHash?: string }>;
    indexTxHash?: string;
  }> {
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    // Store all files and capture transaction hashes
    const fileResults: Array<{ path: string; size: number; key: string; txHash?: string }> = [];
    let indexTxHash: string | undefined;

    for (const file of files) {
      const txHash = await this.storeFile(siteId, file);
      fileResults.push({
        path: file.path,
        size: file.size,
        key: this.generateFileKey(siteId, file.path),
        txHash: txHash || undefined,
      });

      // Capture the index.html transaction hash for the explorer link
      if (file.path === 'index.html') {
        indexTxHash = txHash || undefined;
      }
    }

    const metadata: SiteMetadata = {
      siteId,
      name: siteId,
      domain: `${siteId}.webdb.site`,
      totalSize,
      fileCount: files.length,
      createdAt: new Date(),
      btlExpiry: new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)), // 30 days
    };

    // Store metadata
    const metadataKey = this.generateMetadataKey(siteId);
    const metadataEntry: DBChainEntry = {
      key: metadataKey,
      value: new TextEncoder().encode(JSON.stringify(metadata)),
      metadata: {
        contentType: 'application/json',
        path: '_metadata',
        siteId,
        size: JSON.stringify(metadata).length,
        lastModified: new Date().toISOString(),
      },
      btl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60),
    };

    await this.writeToGolemDB(metadataEntry);
    await this.storeLocally(metadataKey, metadataEntry);

    console.log(`🌐 Created site: ${siteId} with ${files.length} files`);
    return {
      metadata,
      files: fileResults,
      indexTxHash,
    };
  }

  async getFile(siteId: string, path: string): Promise<SiteFile | null> {
    const key = this.generateFileKey(siteId, path);

    try {
      const entry = await this.readLocally(key);
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
      console.error(`❌ Failed to read file ${key}:`, error);
      return null;
    }
  }

  async getSiteMetadata(siteId: string): Promise<SiteMetadata | null> {
    const key = this.generateMetadataKey(siteId);

    try {
      const entry = await this.readLocally(key);
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
      console.error(`❌ Failed to read metadata ${key}:`, error);
      return null;
    }
  }

  private async storeLocally(key: string, entry: DBChainEntry) {
    const filePath = join(STORAGE_DIR, `${key}.json`);
    const data = {
      key: entry.key,
      value: Array.from(entry.value),
      metadata: entry.metadata,
      btl: entry.btl,
    };
    await writeFile(filePath, JSON.stringify(data));
  }

  private async readLocally(key: string): Promise<DBChainEntry | null> {
    try {
      const filePath = join(STORAGE_DIR, `${key}.json`);
      const data = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(data);

      return {
        key: parsed.key,
        value: new Uint8Array(parsed.value),
        metadata: parsed.metadata,
        btl: parsed.btl,
      };
    } catch {
      return null;
    }
  }

  private async writeToGolemDB(entry: DBChainEntry): Promise<string | null> {
    try {
      const result = await this.golemDB.createEntity(
        entry.key,
        entry.value,
        {
          contentType: entry.metadata.contentType,
          path: entry.metadata.path,
          siteId: entry.metadata.siteId,
          size: entry.metadata.size.toString(),
          lastModified: entry.metadata.lastModified
        },
        entry.btl
      );

      console.log(`✅ Stored in Golem DB: ${entry.key}, TX: ${result.transactionHash}, Entity: ${result.entityKey}`);
      return result.entityKey; // Return entity key for explorer links
    } catch (error) {
      console.log(`⚠️ Golem DB error:`, error);
      return null;
    }
  }


  private generateFileKey(siteId: string, path: string): string {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return `site:${siteId}:file:${normalizedPath}`;
  }

  private generateMetadataKey(siteId: string): string {
    return `site:${siteId}:metadata`;
  }

  private isExpired(entry: DBChainEntry): boolean {
    const now = Math.floor(Date.now() / 1000);
    return entry.btl > 0 && now > entry.btl;
  }
}