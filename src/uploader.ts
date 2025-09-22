import { z } from 'zod';
import { lookup } from 'mime-types';
import { GolemDBStorage } from './db-chain.js';
import { DemoStorage } from './demo-storage.js';
import { FileStorage } from './file-storage.js';
import type { SiteFile, UploadResult } from './types.js';

const uploadSchema = z.object({
  siteId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9-_]+$/),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.instanceof(Uint8Array),
  })).min(1).max(1000), // Maximum 1000 files per site
});

export class SiteUploader {
  private storage: GolemDBStorage | DemoStorage | FileStorage;
  private maxFileSize: number;
  private maxSiteSize: number;

  constructor(dbChainRpcUrl: string, maxFileSize = 2 * 1024 * 1024, maxSiteSize = 50 * 1024 * 1024, useFileStorage = false) {
    if (useFileStorage) {
      this.storage = new FileStorage(dbChainRpcUrl);
    } else {
      this.storage = new GolemDBStorage(dbChainRpcUrl);
    }
    this.maxFileSize = maxFileSize;
    this.maxSiteSize = maxSiteSize;
  }

  async uploadSite(siteId: string, files: Array<{ path: string; content: Uint8Array }>): Promise<UploadResult> {
    // Validate input
    const validation = uploadSchema.safeParse({ siteId, files });
    if (!validation.success) {
      throw new Error(`Invalid upload data: ${validation.error.message}`);
    }

    // Check if site already exists
    const existingMetadata = await this.storage.getSiteMetadata(siteId);
    if (existingMetadata) {
      throw new Error(`Site ${siteId} already exists`);
    }

    // Process files
    const siteFiles: SiteFile[] = [];
    let totalSize = 0;

    for (const fileData of files) {
      const file = this.processFile(fileData);

      if (file.size > this.maxFileSize) {
        throw new Error(`File ${file.path} exceeds maximum size of ${this.maxFileSize / 1024 / 1024}MB`);
      }

      totalSize += file.size;
      if (totalSize > this.maxSiteSize) {
        throw new Error(`Site exceeds maximum size of ${this.maxSiteSize / 1024 / 1024}MB`);
      }

      siteFiles.push(file);
    }

    // Validate required files
    this.validateSiteStructure(siteFiles);

    // Store site in DB-Chain
    const result = await this.storage.storeSite(siteId, siteFiles);

    // Return upload result
    return {
      siteId,
      domain: result.metadata.domain,
      files: result.files,
      totalSize,
      indexTxHash: result.indexTxHash,
    };
  }

  async uploadFiles(siteId: string, files: Array<{ path: string; content: Uint8Array }>): Promise<UploadResult> {
    // Check if site exists
    const metadata = await this.storage.getSiteMetadata(siteId);
    if (!metadata) {
      throw new Error(`Site ${siteId} does not exist`);
    }

    // Check if site has expired
    if (new Date() > metadata.btlExpiry) {
      throw new Error(`Site ${siteId} has expired`);
    }

    const siteFiles: SiteFile[] = [];
    let totalSize = metadata.totalSize;

    for (const fileData of files) {
      const file = this.processFile(fileData);

      if (file.size > this.maxFileSize) {
        throw new Error(`File ${file.path} exceeds maximum size of ${this.maxFileSize / 1024 / 1024}MB`);
      }

      // Check if file already exists and subtract its current size
      const existingFile = await this.storage.getFile(siteId, file.path);
      if (existingFile) {
        totalSize -= existingFile.size;
      }

      totalSize += file.size;
      if (totalSize > this.maxSiteSize) {
        throw new Error(`Site would exceed maximum size of ${this.maxSiteSize / 1024 / 1024}MB`);
      }

      siteFiles.push(file);
    }

    // Store files
    const keys: string[] = [];
    for (const file of siteFiles) {
      const key = await this.storage.storeFile(siteId, file);
      keys.push(key);
    }

    return {
      siteId,
      domain: metadata.domain,
      files: siteFiles.map((file, index) => ({
        path: file.path,
        size: file.size,
        key: keys[index],
      })),
      totalSize,
    };
  }

  private processFile(fileData: { path: string; content: Uint8Array }): SiteFile {
    // Normalize path
    let path = fileData.path.replace(/\\/g, '/'); // Convert Windows paths
    if (path.startsWith('/')) {
      path = path.slice(1);
    }

    // Validate path
    if (path.includes('..') || path.includes('//')) {
      throw new Error(`Invalid file path: ${path}`);
    }

    if (path.length === 0) {
      throw new Error('Empty file path');
    }

    // Determine content type
    const contentType = lookup(path) || 'application/octet-stream';

    return {
      path,
      content: fileData.content,
      contentType,
      size: fileData.content.length,
      lastModified: new Date(),
    };
  }

  private validateSiteStructure(files: SiteFile[]): void {
    // Check for index file
    const hasIndexHtml = files.some(f => f.path === 'index.html');
    const hasIndexHtm = files.some(f => f.path === 'index.htm');

    if (!hasIndexHtml && !hasIndexHtm) {
      throw new Error('Site must contain an index.html or index.htm file');
    }

    // Check for suspicious files
    const suspiciousExtensions = ['.exe', '.bat', '.sh', '.php', '.asp', '.jsp'];
    for (const file of files) {
      const extension = file.path.toLowerCase().split('.').pop();
      if (extension && suspiciousExtensions.includes(`.${extension}`)) {
        throw new Error(`File type not allowed: ${file.path}`);
      }
    }

    // Check for hidden files (except common ones)
    const allowedHiddenFiles = ['.htaccess', '.well-known'];
    for (const file of files) {
      if (file.path.startsWith('.')) {
        const isAllowed = allowedHiddenFiles.some(allowed =>
          file.path === allowed || file.path.startsWith(allowed + '/')
        );
        if (!isAllowed) {
          throw new Error(`Hidden file not allowed: ${file.path}`);
        }
      }
    }
  }

  private generateFileKey(siteId: string, path: string): string {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return `site:${siteId}:file:${normalizedPath}`;
  }
}