export interface SiteFile {
  path: string;
  content: Uint8Array;
  contentType: string;
  size: number;
  lastModified: Date;
}

export interface SiteMetadata {
  siteId: string;
  name: string;
  domain: string;
  totalSize: number;
  fileCount: number;
  createdAt: Date;
  btlExpiry: Date;
}

export interface DBChainEntry {
  key: string;
  value: Uint8Array;
  metadata: {
    contentType: string;
    path: string;
    siteId: string;
    size: number;
    lastModified: string;
  };
  btl: number;
}

export interface UploadResult {
  siteId: string;
  domain: string;
  files: Array<{
    path: string;
    size: number;
    key: string;
    txHash?: string; // Transaction hash for blockchain storage
  }>;
  totalSize: number;
  indexTxHash?: string; // Transaction hash for index.html file (for explorer link)
}

export interface GatewayConfig {
  port: number;
  hostname: string;
  domain: string;
  dbChainRpcUrl: string;
  maxFileSize: number;
  maxSiteSize: number;
  cors: {
    origins: string[];
    methods: string[];
    headers: string[];
  };
}