import type { DBChainEntry, SiteFile, SiteMetadata } from './types.js';

// In-memory storage for demo purposes
const demoStorage = new Map<string, DBChainEntry>();

export class DemoStorage {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
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

    demoStorage.set(key, entry);
    console.log(`[DEMO] Stored file: ${key} (${file.size} bytes)`);
    return key;
  }

  async storeSite(siteId: string, files: SiteFile[]): Promise<SiteMetadata> {
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    // Store all files
    for (const file of files) {
      await this.storeFile(siteId, file);
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

    demoStorage.set(metadataKey, metadataEntry);
    console.log(`[DEMO] Created site: ${siteId} with ${files.length} files`);

    return metadata;
  }

  async getFile(siteId: string, path: string): Promise<SiteFile | null> {
    const key = this.generateFileKey(siteId, path);
    const entry = demoStorage.get(key);

    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      demoStorage.delete(key);
      return null;
    }

    return {
      path: entry.metadata.path,
      content: entry.value,
      contentType: entry.metadata.contentType,
      size: entry.metadata.size,
      lastModified: new Date(entry.metadata.lastModified),
    };
  }

  async getSiteMetadata(siteId: string): Promise<SiteMetadata | null> {
    const key = this.generateMetadataKey(siteId);
    const entry = demoStorage.get(key);

    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      demoStorage.delete(key);
      return null;
    }

    const metadata = JSON.parse(new TextDecoder().decode(entry.value));
    return {
      ...metadata,
      createdAt: new Date(metadata.createdAt),
      btlExpiry: new Date(metadata.btlExpiry),
    };
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