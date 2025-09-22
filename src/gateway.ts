import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { lookup } from 'mime-types';
import { GolemDBStorage } from './db-chain.js';
import { DemoStorage } from './demo-storage.js';
import { FileStorage } from './file-storage.js';
import { SiteUploader } from './uploader.js';
import type { GatewayConfig } from './types.js';

const config: GatewayConfig = {
  port: Number(process.env.PORT) || 3000,
  hostname: process.env.HOSTNAME || '0.0.0.0',
  domain: process.env.DOMAIN || 'webdb.site',
  dbChainRpcUrl: process.env.DBCHAIN_RPC_URL || process.env.GOLEM_RPC_URL || 'https://kaolin.holesky.golemdb.io/rpc',
  maxFileSize: 2 * 1024 * 1024, // 2MB
  maxSiteSize: 50 * 1024 * 1024, // 50MB
  cors: {
    origins: process.env.CORS_ORIGINS?.split(',') || ['*'],
    methods: ['GET', 'HEAD', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization'],
  },
};

const app = new Hono();
// Use file storage with Golem DB backup
const storage = new FileStorage(config.dbChainRpcUrl);
const uploader = new SiteUploader(config.dbChainRpcUrl, config.maxFileSize, config.maxSiteSize, true); // Use file storage

// CORS middleware
app.use('*', cors({
  origin: config.cors.origins,
  allowMethods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowHeaders: config.cors.headers,
}));

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Upload site endpoint
app.post('/api/upload/:siteId', async (c) => {
  const siteId = c.req.param('siteId');

  try {
    const formData = await c.req.formData();
    const files: Array<{ path: string; content: Uint8Array }> = [];

    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        const content = new Uint8Array(await value.arrayBuffer());
        const path = key.startsWith('files[') ? key.slice(6, -1) : value.name || key;
        files.push({ path, content });
      }
    }

    if (files.length === 0) {
      return c.json({ error: 'No files provided' }, 400);
    }

    const result = await uploader.uploadSite(siteId, files);
    return c.json(result);
  } catch (error) {
    console.error(`Upload error for ${siteId}:`, error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return c.json({ error: message }, 400);
  }
});

// Upload additional files to existing site
app.post('/api/upload/:siteId/files', async (c) => {
  const siteId = c.req.param('siteId');

  try {
    const formData = await c.req.formData();
    const files: Array<{ path: string; content: Uint8Array }> = [];

    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        const content = new Uint8Array(await value.arrayBuffer());
        const path = key.startsWith('files[') ? key.slice(6, -1) : value.name || key;
        files.push({ path, content });
      }
    }

    if (files.length === 0) {
      return c.json({ error: 'No files provided' }, 400);
    }

    const result = await uploader.uploadFiles(siteId, files);
    return c.json(result);
  } catch (error) {
    console.error(`File upload error for ${siteId}:`, error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return c.json({ error: message }, 400);
  }
});

// Get site metadata
app.get('/api/sites/:siteId', async (c) => {
  const siteId = c.req.param('siteId');

  try {
    const metadata = await storage.getSiteMetadata(siteId);
    if (!metadata) {
      return c.json({ error: 'Site not found' }, 404);
    }

    return c.json(metadata);
  } catch (error) {
    console.error(`Error getting site metadata for ${siteId}:`, error);
    return c.json({ error: 'Failed to get site metadata' }, 500);
  }
});

// Subdomain handler middleware
app.use('*', async (c, next) => {
  const host = c.req.header('host') || '';
  const domain = process.env.DOMAIN || 'webdb.site';

  console.log(`🌐 Middleware: host=${host}, domain=${domain}`);

  if (host !== domain && host.endsWith('.' + domain)) {
    const siteId = host.replace('.' + domain, '');
    const path = c.req.path === '/' ? '/index.html' : c.req.path;

    try {
      const metadata = await storage.getSiteMetadata(siteId);
      if (!metadata) {
        return c.html(createNotFoundPage('Site not found'), 404);
      }

      if (new Date() > metadata.btlExpiry) {
        return c.html(createExpiredPage(siteId, metadata.btlExpiry), 404);
      }

      const filePath = path.startsWith('/') ? path.slice(1) : path;
      const file = await storage.getFile(siteId, filePath || 'index.html');

      if (!file) {
        if (filePath === 'index.html' || filePath === '') {
          const indexHtm = await storage.getFile(siteId, 'index.htm');
          if (indexHtm) {
            return serveFile(c, indexHtm);
          }
        }
        return c.html(createNotFoundPage('File not found'), 404);
      }

      return serveFile(c, file);
    } catch (error) {
      console.error(`Error serving subdomain ${siteId}${path}:`, error);
      return c.html(createErrorPage('Internal server error'), 500);
    }
  }

  await next();
});

// Main site root - serve landing page
app.get('/', async (c) => {
  return c.html(createLandingPage());
});

// API documentation page
app.get('/api', async (c) => {
  return c.html(createApiDocPage());
});

// Serve static site files
app.get('/:siteId/*', async (c) => {
  const siteId = c.req.param('siteId');
  const path = c.req.param('*') || 'index.html';

  try {
    // First check if site metadata exists
    const metadata = await storage.getSiteMetadata(siteId);
    if (!metadata) {
      return c.html(createNotFoundPage('Site not found'), 404);
    }

    // Check if site has expired
    if (new Date() > metadata.btlExpiry) {
      return c.html(createExpiredPage(siteId, metadata.btlExpiry), 404);
    }

    // Get the requested file
    const file = await storage.getFile(siteId, path);
    if (!file) {
      // If requesting root and no index.html, try index.htm
      if (path === 'index.html') {
        const indexHtm = await storage.getFile(siteId, 'index.htm');
        if (indexHtm) {
          return serveFile(c, indexHtm);
        }
      }
      return c.html(createNotFoundPage('File not found'), 404);
    }

    return serveFile(c, file);
  } catch (error) {
    console.error(`Error serving ${siteId}/${path}:`, error);
    return c.html(createErrorPage('Internal server error'), 500);
  }
});

// Serve site root (redirect to index.html)
app.get('/:siteId', async (c) => {
  const siteId = c.req.param('siteId');
  return c.redirect(`/${siteId}/index.html`);
});

function serveFile(c: any, file: any) {
  // Set content type
  const contentType = file.contentType || lookup(file.path) || 'application/octet-stream';

  // Set security headers
  c.header('Content-Type', contentType);
  c.header('Content-Length', file.size.toString());
  c.header('Last-Modified', file.lastModified.toUTCString());
  c.header('Cache-Control', 'public, max-age=3600'); // 1 hour cache

  // Set security headers
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('X-XSS-Protection', '1; mode=block');

  return c.body(file.content);
}

function createNotFoundPage(message: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 - Not Found</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #e74c3c; }
        p { color: #7f8c8d; }
    </style>
</head>
<body>
    <div class="container">
        <h1>404 - Not Found</h1>
        <p>${message}</p>
        <p>The requested resource could not be found on this server.</p>
    </div>
</body>
</html>`;
}

function createExpiredPage(siteId: string, expiry: Date): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Site Expired</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #f39c12; }
        p { color: #7f8c8d; }
        .expired-info { background: #fff3cd; padding: 20px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Site Expired</h1>
        <div class="expired-info">
            <p><strong>Site:</strong> ${siteId}</p>
            <p><strong>Expired:</strong> ${expiry.toLocaleString()}</p>
        </div>
        <p>This site's data has expired and is no longer available.</p>
        <p>Golem DB entities have a limited lifetime (BTL) and this site's content has exceeded that limit.</p>
    </div>
</body>
</html>`;
}

function createErrorPage(message: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #e74c3c; }
        p { color: #7f8c8d; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Error</h1>
        <p>${message}</p>
        <p>Please try again later.</p>
    </div>
</body>
</html>`;
}

function createApiDocPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebDB API Documentation</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 2rem; }

        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem 0; }
        .header h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
        .header p { font-size: 1.2rem; opacity: 0.9; }

        .content { padding: 3rem 0; }
        .section { margin-bottom: 3rem; }
        .section h2 { color: #2c3e50; margin-bottom: 1.5rem; font-size: 2rem; }
        .section h3 { color: #34495e; margin: 2rem 0 1rem 0; font-size: 1.3rem; }

        .code-block { background: #1e1e1e; color: #f8f8f2; padding: 1.5rem; border-radius: 8px; margin: 1rem 0; font-family: 'Monaco', 'Courier New', monospace; overflow-x: auto; position: relative; }
        .copy-btn { position: absolute; top: 10px; right: 10px; background: #4a5568; color: white; border: none; padding: 8px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }
        .copy-btn:hover { background: #2d3748; }

        .endpoint { background: #f8f9fa; border-left: 4px solid #667eea; padding: 1.5rem; margin: 1rem 0; border-radius: 0 8px 8px 0; }
        .method { display: inline-block; background: #667eea; color: white; padding: 0.3rem 0.8rem; border-radius: 4px; font-weight: bold; margin-right: 1rem; }

        .back-link { display: inline-block; color: #667eea; text-decoration: none; margin-bottom: 2rem; }
        .back-link:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <div class="container">
            <h1>API Documentation</h1>
            <p>Complete guide to deploying sites on WebDB</p>
        </div>
    </div>

    <div class="content">
        <div class="container">
            <a href="/" class="back-link">← Back to Home</a>

            <div class="section">
                <h2>Getting Started</h2>
                <p>WebDB provides a simple REST API for deploying static sites to the blockchain. All sites are stored immutably on Golem DB and served via subdomains.</p>
            </div>

            <div class="section">
                <h2>Authentication</h2>
                <p>No authentication required for the free tier. Simply start uploading!</p>
            </div>

            <div class="section">
                <h2>Endpoints</h2>

                <div class="endpoint">
                    <span class="method">POST</span>
                    <strong>/api/upload/:siteId</strong>
                    <p>Deploy a new site with multiple files</p>
                </div>

                <h3>Upload Your Site</h3>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>curl -X POST https://webdb.site/api/upload/mysite \\
  -F "files=@index.html;filename=index.html" \\
  -F "files=@style.css;filename=style.css" \\
  -F "files=@script.js;filename=script.js"</pre>
                </div>

                <h3>Response</h3>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>{
  "success": true,
  "siteId": "mysite",
  "url": "https://mysite.webdb.site",
  "files": [
    { "path": "index.html", "size": 2048, "txHash": "0x..." },
    { "path": "style.css", "size": 1024, "txHash": "0x..." }
  ]
}</pre>
                </div>

                <div class="endpoint">
                    <span class="method">GET</span>
                    <strong>/api/sites/:siteId</strong>
                    <p>Get site metadata and file information</p>
                </div>

                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>curl https://webdb.site/api/sites/mysite</pre>
                </div>

                <div class="endpoint">
                    <span class="method">GET</span>
                    <strong>/health</strong>
                    <p>Check service status</p>
                </div>

                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>curl https://webdb.site/health</pre>
                </div>
            </div>

            <div class="section">
                <h2>File Upload</h2>
                <p>Upload multiple files in a single request:</p>

                <h3>HTML + CSS + JS Example</h3>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>curl -X POST https://webdb.site/api/upload/my-portfolio \\
  -F "files=@index.html;filename=index.html" \\
  -F "files=@styles/main.css;filename=main.css" \\
  -F "files=@js/app.js;filename=app.js" \\
  -F "files=@images/logo.png;filename=logo.png"</pre>
                </div>

                <h3>Using JavaScript</h3>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>const formData = new FormData();
formData.append('files', file1, 'index.html');
formData.append('files', file2, 'style.css');

const response = await fetch('/api/upload/mysite', {
  method: 'POST',
  body: formData
});

const result = await response.json();</pre>
                </div>
            </div>

            <div class="section">
                <h2>Limits</h2>
                <ul>
                    <li>Maximum file size: 2 MB</li>
                    <li>Maximum site size: 50 MB</li>
                    <li>Sites expire after 30 days (BTL)</li>
                    <li>Subdomain format: yoursite.webdb.site</li>
                </ul>
            </div>

            <div class="section">
                <h2>Examples</h2>

                <h3>Deploy NFT Gallery</h3>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>curl -X POST https://webdb.site/api/upload/nft-gallery \\
  -F "files=@gallery.html;filename=index.html" \\
  -F "files=@gallery.css;filename=style.css"</pre>
                </div>

                <h3>Deploy Documentation</h3>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>curl -X POST https://webdb.site/api/upload/project-docs \\
  -F "files=@docs/index.html;filename=index.html" \\
  -F "files=@docs/api.html;filename=api.html"</pre>
                </div>
            </div>

            <div class="section">
                <h2>Blockchain Integration</h2>
                <p>All files are stored on Golem DB blockchain. View transactions at:</p>
                <div class="code-block">
                    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
                    <pre>https://explorer.kaolin.holesky.golemdb.io</pre>
                </div>
            </div>
        </div>
    </div>

    <script>
        function copyCode(button) {
            const pre = button.nextElementSibling;
            const text = pre.textContent;

            navigator.clipboard.writeText(text).then(() => {
                const originalText = button.textContent;
                button.textContent = 'Copied!';

                setTimeout(() => {
                    button.textContent = originalText;
                }, 2000);
            });
        }
    </script>
</body>
</html>`;
}

function createLandingPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebDB - Deploy static sites on Golem DB</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }

        /* Hero Section */
        .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 6rem 0; text-align: center; }
        .hero h1 { font-size: 3.5rem; margin-bottom: 1rem; font-weight: 700; line-height: 1.2; }
        .hero-subtitle { font-size: 1.3rem; opacity: 0.9; margin-bottom: 3rem; max-width: 600px; margin-left: auto; margin-right: auto; }
        .hero-ctas { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }
        .btn { display: inline-block; padding: 16px 32px; border-radius: 8px; font-weight: 600; font-size: 1.1rem; text-decoration: none; transition: all 0.2s; cursor: pointer; border: none; }
        .btn-primary { background: #fff; color: #667eea; }
        .btn-primary:hover { background: #f0f0f0; transform: translateY(-2px); }
        .btn-secondary { background: rgba(255,255,255,0.1); color: white; border: 2px solid rgba(255,255,255,0.3); }
        .btn-secondary:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.5); }

        /* Feature Cards */
        .features { padding: 6rem 0; background: #f8f9fa; }
        .features h2 { text-align: center; margin-bottom: 3rem; font-size: 2.5rem; color: #2c3e50; }
        .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; }
        .feature-card { background: white; padding: 2rem; border-radius: 16px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.05); transition: transform 0.2s; }
        .feature-card:hover { transform: translateY(-4px); }
        .feature-icon { font-size: 3rem; margin-bottom: 1.5rem; }
        .feature-card h3 { color: #2c3e50; margin-bottom: 1rem; font-size: 1.3rem; }
        .feature-card p { color: #6c757d; }

        /* NFT Section */
        .nft-section { padding: 5rem 0; background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); }
        .nft-section h2 { text-align: center; color: #2c3e50; margin-bottom: 3rem; font-size: 2.5rem; }

        /* Limits Section */
        .limits-section { padding: 5rem 0; background: white; }
        .limits-section h2 { text-align: center; color: #2c3e50; margin-bottom: 3rem; font-size: 2.5rem; }

        /* Deploy Methods */
        .deploy-methods { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 2rem; margin-bottom: 3rem; }
        .deploy-card { background: white; border: 2px solid #e9ecef; border-radius: 16px; padding: 2rem; text-align: center; cursor: pointer; transition: all 0.3s ease; position: relative; overflow: hidden; }
        .deploy-card:hover { border-color: #667eea; transform: translateY(-5px); box-shadow: 0 10px 30px rgba(102, 126, 234, 0.15); }
        .deploy-card:before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }

        .deploy-icon { font-size: 3rem; margin-bottom: 1.5rem; }
        .deploy-card h4 { color: #2c3e50; margin-bottom: 1rem; font-size: 1.4rem; }
        .deploy-card p { color: #6c757d; margin-bottom: 1.5rem; line-height: 1.6; }

        .deploy-features { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
        .feature-tag { background: #f8f9fa; color: #667eea; padding: 0.3rem 0.8rem; border-radius: 20px; font-size: 0.8rem; font-weight: 600; border: 1px solid #e9ecef; }

        /* WYSIWYG Modal */
        .wysiwyg-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; display: flex; align-items: center; justify-content: center; }
        .wysiwyg-content { background: white; width: 95%; height: 95%; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }

        .wysiwyg-header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; border-bottom: 1px solid #eee; background: #f8f9fa; }
        .wysiwyg-header-left { display: flex; align-items: center; gap: 1rem; flex: 1; }
        .site-id-input { flex: 1; max-width: 300px; padding: 0.5rem 1rem; border: 2px solid #e9ecef; border-radius: 8px; font-size: 1rem; }
        .wysiwyg-controls { display: flex; gap: 1rem; }

        .upload-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid #e9ecef; }
        .upload-header h3 { margin: 0; color: #2c3e50; font-size: 1.5rem; }

        .wysiwyg-toolbar { display: flex; align-items: center; padding: 1rem 2rem; border-bottom: 1px solid #eee; background: #fff; flex-wrap: wrap; gap: 0.5rem; }
        .toolbar-btn { background: #f8f9fa; border: 1px solid #dee2e6; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
        .toolbar-btn:hover { background: #e9ecef; }
        .toolbar-divider { color: #dee2e6; margin: 0 0.5rem; }
        .template-select { padding: 0.5rem; border: 1px solid #dee2e6; border-radius: 6px; background: white; }

        .wysiwyg-editor { flex: 1; padding: 2rem; overflow-y: auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; }
        .wysiwyg-editor:focus { outline: none; }
        .wysiwyg-editor h1 { color: #2c3e50; margin-bottom: 1rem; }
        .wysiwyg-editor p { color: #5a6c7d; margin-bottom: 1rem; }

        /* API Section */
        .api-section { background: white; padding: 6rem 0; }
        .api-section h2 { text-align: center; margin-bottom: 3rem; font-size: 2.5rem; color: #2c3e50; }
        .api-section h3 { margin: 2rem 0 1rem 0; color: #2c3e50; }

        /* Upload Form */
        .upload-form-container { background: #f8f9fa; padding: 2rem; border-radius: 12px; margin: 2rem 0; border: 1px solid #e9ecef; }
        .upload-form { max-width: 600px; margin: 0 auto; }
        .form-group { margin-bottom: 2rem; }
        .form-label { display: block; margin-bottom: 0.5rem; font-weight: 600; color: #2c3e50; }
        .form-input, .form-select { width: 100%; padding: 12px 16px; border: 2px solid #e9ecef; border-radius: 8px; font-size: 1rem; transition: border-color 0.2s; background: white; }
        .form-input:focus, .form-select:focus { outline: none; border-color: #667eea; }
        .form-input.error { border-color: #e74c3c; }
        .form-hint { margin-top: 0.5rem; font-size: 0.9rem; color: #6c757d; }
        .form-error { margin-top: 0.5rem; font-size: 0.9rem; color: #e74c3c; display: none; }

        /* File Upload Area */
        .file-upload-area { border: 2px dashed #cbd5e0; border-radius: 12px; padding: 2rem; text-align: center; transition: all 0.2s; cursor: pointer; background: white; }
        .file-upload-area:hover, .file-upload-area.drag-over { border-color: #667eea; background: #f7faff; }
        .upload-icon { font-size: 3rem; margin-bottom: 1rem; }
        .upload-text { font-size: 1.1rem; margin-bottom: 0.5rem; }
        .upload-link { color: #667eea; text-decoration: underline; cursor: pointer; }
        .upload-hint { color: #6c757d; font-size: 0.9rem; }

        /* File List */
        .file-list { margin-top: 1rem; }
        .file-item { display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 1rem; background: white; border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 0.5rem; }
        .file-info { display: flex; align-items: center; }
        .file-icon { margin-right: 0.5rem; font-size: 1.2rem; }
        .file-name { font-weight: 500; }
        .file-size { color: #6c757d; font-size: 0.9rem; margin-left: 0.5rem; }
        .file-remove { background: none; border: none; color: #e74c3c; cursor: pointer; font-size: 1.2rem; padding: 4px; }

        /* Deploy Button */
        .deploy-button { width: 100%; padding: 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 1.1rem; font-weight: 600; cursor: pointer; transition: all 0.2s; position: relative; }
        .deploy-button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .deploy-button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
        .button-spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top: 2px solid white; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        /* Custom Modals */
        .custom-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 2000; display: flex; align-items: center; justify-content: center; }
        .modal-content { background: white; border-radius: 12px; max-width: 500px; width: 90%; margin: 2rem; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }

        .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1.5rem 2rem; border-bottom: 1px solid #eee; }
        .modal-header h3 { margin: 0; color: #2c3e50; }
        .close-btn { background: none; border: none; font-size: 1.5rem; color: #6c757d; cursor: pointer; padding: 0; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; }
        .close-btn:hover { color: #dc3545; }

        .modal-body { padding: 2rem; }
        .modal-body p { margin: 0 0 1rem 0; color: #5a6c7d; line-height: 1.6; }
        .modal-input { width: 100%; padding: 0.75rem 1rem; border: 2px solid #e9ecef; border-radius: 8px; font-size: 1rem; margin-top: 1rem; }
        .modal-input:focus { outline: none; border-color: #667eea; }

        .modal-footer { display: flex; gap: 1rem; justify-content: flex-end; padding: 1.5rem 2rem; border-top: 1px solid #eee; }

        /* Success/Error modal colors */
        .alert-modal.success .modal-header h3 { color: #28a745; }
        .alert-modal.error .modal-header h3 { color: #dc3545; }
        .alert-modal.success .modal-header { border-bottom-color: #28a745; }
        .alert-modal.error .modal-header { border-bottom-color: #dc3545; }

        /* Progress */
        .upload-progress { margin-top: 2rem; }
        .progress-bar { width: 100%; height: 8px; background: #e9ecef; border-radius: 4px; overflow: hidden; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); border-radius: 4px; transition: width 0.3s; width: 0%; }
        .progress-text { text-align: center; margin-top: 1rem; color: #2c3e50; font-weight: 500; }

        /* Upload Result */
        .upload-result { margin-top: 2rem; padding: 1.5rem; border-radius: 8px; }
        .result-success { background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); border: 2px solid #b8dacd; color: #155724; }
        .result-error { background: linear-gradient(135deg, #f8d7da 0%, #f1c2c7 100%); border: 2px solid #f5b7b1; color: #721c24; }
        .result-actions { margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .result-button { padding: 8px 16px; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; transition: all 0.2s; text-decoration: none; display: inline-block; }
        .btn-open { background: #28a745; color: white; }
        .btn-copy { background: #6c757d; color: white; }
        .btn-explorer { background: #17a2b8; color: white; }
        .result-button:hover { transform: translateY(-1px); }

        /* Footer */
        .footer { background: #2c3e50; color: white; padding: 3rem 0; }
        .footer-content { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 2rem; margin-bottom: 2rem; }
        .footer-section h4 { margin-bottom: 1rem; }
        .footer-section a { color: #ecf0f1; text-decoration: none; display: block; margin-bottom: 0.5rem; }
        .footer-section a:hover { color: #3498db; }
        .footer-bottom { text-align: center; padding-top: 2rem; border-top: 1px solid #34495e; color: #95a5a6; }

        @media (max-width: 768px) {
            .hero h1 { font-size: 2.5rem; }
            .hero-ctas { flex-direction: column; align-items: center; }
            .features-grid { grid-template-columns: 1fr; }
            .btn { width: 100%; max-width: 300px; }

            /* Mobile upload form */
            .upload-form-container { padding: 1.5rem 1rem; margin: 1rem 0; }
            .file-upload-area { padding: 1.5rem; }
            .upload-icon { font-size: 2rem; }
            .result-actions { flex-direction: column; }
            .result-button { text-align: center; }
            .file-item { flex-direction: column; align-items: flex-start; padding: 1rem; }
            .file-info { margin-bottom: 0.5rem; }
            .footer-content { grid-template-columns: 1fr; text-align: center; }

            /* Mobile Deploy & WYSIWYG */
            .deploy-methods { grid-template-columns: 1fr; gap: 1.5rem; }
            .deploy-card { padding: 2rem; }
            .wysiwyg-content { width: 98%; height: 98%; }
            .wysiwyg-header { flex-direction: column; gap: 1rem; text-align: center; }
            .wysiwyg-header-left { flex-direction: column; gap: 1rem; width: 100%; }
            .site-id-input { max-width: 100%; }
            .wysiwyg-toolbar { flex-direction: column; align-items: stretch; }
            .toolbar-btn { margin: 0.2rem; }
            .upload-header { flex-direction: column; align-items: flex-start; gap: 1rem; }
            .modal-content { margin: 1rem; }
            .modal-footer { flex-direction: column; }
        }
    </style>
</head>
<body>
    <!-- Hero Section -->
    <section class="hero">
        <div class="container">
            <h1>Deploy static sites on Golem DB</h1>
            <p class="hero-subtitle">Immutable, decentralized hosting for microsites and NFT assets</p>
            <div class="hero-ctas">
                <a href="#demo" class="btn btn-primary" onclick="scrollToDemo()">Deploy a site</a>
                <a href="/api" class="btn btn-secondary">API docs</a>
            </div>
        </div>
    </section>

    <!-- Features Section -->
    <section class="features">
        <div class="container">
            <h2>Why WebDB?</h2>
            <div class="features-grid">
                <div class="feature-card">
                    <div class="feature-icon">🔒</div>
                    <h3>Immutable Hosting</h3>
                    <p>Sites stored on Golem DB are tamper-proof and permanently accessible.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">⚡</div>
                    <h3>Simple Upload</h3>
                    <p>Deploy via REST API - just HTML, CSS, JS, and images.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🎨</div>
                    <h3>Perfect for NFTs</h3>
                    <p>Host metadata, images, and interactive galleries on-chain.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🆓</div>
                    <h3>Free Tier</h3>
                    <p>Start with webdb.site subdomains at no cost.</p>
                </div>
            </div>
        </div>
    </section>

    <!-- NFT Use Cases Section -->
    <section class="nft-section">
        <div class="container">
            <h2>Perfect for Web3</h2>
            <div class="features-grid">
                <div class="feature-card">
                    <div class="feature-icon">🖼️</div>
                    <h3>NFT Galleries</h3>
                    <p>Showcase collections with custom galleries that live forever.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🎨</div>
                    <h3>Artist Portfolios</h3>
                    <p>Create immutable profiles linked to your NFT drops.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🚀</div>
                    <h3>Project Landing</h3>
                    <p>Build permanent pages for NFT projects and drops.</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🔗</div>
                    <h3>Metadata Hosting</h3>
                    <p>Store NFT metadata with guaranteed availability.</p>
                </div>
            </div>
        </div>
    </section>

    <!-- Limits Section -->
    <section class="limits-section">
        <div class="container">
            <h2>Free Tier Features</h2>
            <div class="features-grid">
                <div class="feature-card">
                    <div class="feature-icon">📁</div>
                    <h3>File Limits</h3>
                    <p>2 MB per file, 50 MB total site size</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">⏰</div>
                    <h3>30 Day Storage</h3>
                    <p>Sites expire after 30 days (extendable via API)</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🌐</div>
                    <h3>Subdomain</h3>
                    <p>yoursite.webdb.site format included</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon">🔄</div>
                    <h3>API Access</h3>
                    <p>Upload and manage via REST endpoints</p>
                </div>
            </div>
        </div>
    </section>

    <!-- Demo Section -->
    <section class="api-section" id="demo">
        <div class="container">
            <h2>Deploy a Site</h2>

            <h3>🎯 Choose Your Deployment Method</h3>

            <div class="deploy-methods">
                <div class="deploy-card" onclick="openWysiwygEditor()">
                    <div class="deploy-icon">✨</div>
                    <h4>Create with WYSIWYG</h4>
                    <p>Build your site visually with our editor. Perfect for beginners and quick prototypes.</p>
                    <div class="deploy-features">
                        <span class="feature-tag">Templates</span>
                        <span class="feature-tag">No coding</span>
                        <span class="feature-tag">Live preview</span>
                    </div>
                </div>

                <div class="deploy-card" onclick="showFileUpload()">
                    <div class="deploy-icon">📁</div>
                    <h4>Upload Files</h4>
                    <p>Upload your existing HTML, CSS, JS files. Full control over your site structure.</p>
                    <div class="deploy-features">
                        <span class="feature-tag">Multiple files</span>
                        <span class="feature-tag">Full control</span>
                        <span class="feature-tag">Drag & drop</span>
                    </div>
                </div>
            </div>

            <div class="upload-form-container" id="fileUploadSection" style="display: none;">
                <div class="upload-header">
                    <button class="btn btn-outline" onclick="backToOptions()">← Back to Options</button>
                    <h3>Upload Files</h3>
                </div>
                <form id="deployForm" class="upload-form">
                    <!-- Site ID Field -->
                    <div class="form-group">
                        <label for="siteId" class="form-label">Site ID</label>
                        <input type="text" id="siteId" class="form-input" placeholder="my-awesome-site"
                               pattern="[a-zA-Z0-9-_]+" required maxlength="50">
                        <div class="form-hint">Only letters, numbers, hyphens and underscores</div>
                        <div id="siteIdError" class="form-error"></div>
                    </div>

                    <!-- File Upload Area -->
                    <div class="form-group">
                        <label class="form-label">Upload Files</label>
                        <div id="fileUpload" class="file-upload-area">
                            <div class="upload-icon">📁</div>
                            <div class="upload-text">
                                <strong>Drop files here</strong> or <span class="upload-link">click to browse</span>
                            </div>
                            <div class="upload-hint">Zip file or individual HTML/CSS/JS files. Max 50 MB site / 2 MB per file.</div>
                            <input type="file" id="fileInput" multiple accept=".html,.htm,.css,.js,.png,.jpg,.jpeg,.gif,.svg,.ico,.zip" style="display: none;">
                        </div>
                        <div id="fileList" class="file-list"></div>
                    </div>

                    <!-- TTL/BTL Selector -->
                    <div class="form-group">
                        <label for="ttlSelect" class="form-label">Site Duration (TTL)</label>
                        <select id="ttlSelect" class="form-select">
                            <option value="3600">1 hour</option>
                            <option value="86400">1 day</option>
                            <option value="604800">7 days</option>
                            <option value="2592000" selected>30 days (recommended)</option>
                        </select>
                        <div class="form-hint">Sites auto-expire after this time. You can extend via API.</div>
                    </div>

                    <!-- Deploy Button -->
                    <button type="submit" id="deployBtn" class="deploy-button" disabled>
                        <span class="button-text">🚀 Deploy Site</span>
                        <div class="button-spinner" style="display: none;"></div>
                    </button>
                </form>

                <!-- Upload Progress -->
                <div id="uploadProgress" class="upload-progress" style="display: none;">
                    <div class="progress-bar">
                        <div id="progressFill" class="progress-fill"></div>
                    </div>
                    <div id="progressText" class="progress-text">Preparing upload...</div>
                </div>

                <!-- Success/Error Results -->
                <div id="uploadResult" class="upload-result" style="display: none;"></div>
            </div>

            <script>
                // Upload form state
                let selectedFiles = [];

                // DOM elements
                const deployForm = document.getElementById('deployForm');
                const siteIdInput = document.getElementById('siteId');
                const fileUpload = document.getElementById('fileUpload');
                const fileInput = document.getElementById('fileInput');
                const fileList = document.getElementById('fileList');
                const deployBtn = document.getElementById('deployBtn');
                const uploadProgress = document.getElementById('uploadProgress');
                const progressFill = document.getElementById('progressFill');
                const progressText = document.getElementById('progressText');
                const uploadResult = document.getElementById('uploadResult');

                // Site ID validation
                siteIdInput.addEventListener('input', function() {
                    const value = this.value;
                    const error = document.getElementById('siteIdError');

                    if (value && !/^[a-zA-Z0-9-_]+$/.test(value)) {
                        this.classList.add('error');
                        error.style.display = 'block';
                        error.textContent = 'Only letters, numbers, hyphens and underscores allowed';
                        updateDeployButton();
                        return;
                    }

                    if (value.length > 50) {
                        this.classList.add('error');
                        error.style.display = 'block';
                        error.textContent = 'Site ID must be 50 characters or less';
                        updateDeployButton();
                        return;
                    }

                    this.classList.remove('error');
                    error.style.display = 'none';
                    updateDeployButton();
                });

                // File upload handling
                fileUpload.addEventListener('click', () => fileInput.click());
                fileInput.addEventListener('change', handleFileSelect);

                // Drag and drop
                fileUpload.addEventListener('dragover', handleDragOver);
                fileUpload.addEventListener('dragleave', handleDragLeave);
                fileUpload.addEventListener('drop', handleFileDrop);

                function handleDragOver(e) {
                    e.preventDefault();
                    fileUpload.classList.add('drag-over');
                }

                function handleDragLeave(e) {
                    e.preventDefault();
                    fileUpload.classList.remove('drag-over');
                }

                function handleFileDrop(e) {
                    e.preventDefault();
                    fileUpload.classList.remove('drag-over');
                    const files = Array.from(e.dataTransfer.files);
                    addFiles(files);
                }

                function handleFileSelect(e) {
                    const files = Array.from(e.target.files);
                    addFiles(files);
                    e.target.value = ''; // Reset input
                }

                function addFiles(files) {
                    const validFiles = files.filter(file => {
                        if (file.size > 2 * 1024 * 1024) { // 2MB limit
                            showError(\`File "\${file.name}" exceeds 2MB limit\`);
                            return false;
                        }
                        return true;
                    });

                    selectedFiles = [...selectedFiles, ...validFiles];
                    updateFileList();
                    updateDeployButton();
                }

                function updateFileList() {
                    const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);

                    if (totalSize > 50 * 1024 * 1024) { // 50MB site limit
                        showError('Total site size exceeds 50MB limit');
                        return;
                    }

                    fileList.innerHTML = selectedFiles.map((file, index) => \`
                        <div class="file-item">
                            <div class="file-info">
                                <div class="file-icon">\${getFileIcon(file.name)}</div>
                                <div class="file-name">\${file.name}</div>
                                <div class="file-size">(\${formatFileSize(file.size)})</div>
                            </div>
                            <button type="button" class="file-remove" onclick="removeFile(\${index})">×</button>
                        </div>
                    \`).join('');
                }

                function removeFile(index) {
                    selectedFiles.splice(index, 1);
                    updateFileList();
                    updateDeployButton();
                }

                function updateDeployButton() {
                    const siteIdValid = siteIdInput.value && !siteIdInput.classList.contains('error');
                    const hasFiles = selectedFiles.length > 0;
                    const hasIndex = selectedFiles.some(file =>
                        file.name.toLowerCase() === 'index.html' ||
                        file.name.toLowerCase() === 'index.htm'
                    );

                    deployBtn.disabled = !siteIdValid || !hasFiles || !hasIndex;

                    if (hasFiles && !hasIndex) {
                        showError('Please include an index.html or index.htm file');
                    } else {
                        hideError();
                    }
                }

                // Form submission
                deployForm.addEventListener('submit', async function(e) {
                    e.preventDefault();
                    await deployFiles();
                });

                async function deployFiles() {
                    const siteId = siteIdInput.value;

                    try {
                        // Show progress
                        showProgress('Preparing upload...');
                        deployBtn.disabled = true;
                        document.querySelector('.button-text').style.display = 'none';
                        document.querySelector('.button-spinner').style.display = 'block';

                        // Create FormData
                        const formData = new FormData();
                        selectedFiles.forEach(file => {
                            formData.append('files', file, file.name);
                        });

                        updateProgress(25, 'Uploading to Golem DB...');

                        const response = await fetch('/api/upload/' + encodeURIComponent(siteId), {
                            method: 'POST',
                            body: formData
                        });

                        updateProgress(75, 'Processing transaction...');

                        const result = await response.json();

                        if (response.ok) {
                            updateProgress(100, 'Deploy complete!');
                            showSuccess(siteId, result);
                        } else {
                            throw new Error(result.error || 'Upload failed');
                        }

                    } catch (error) {
                        showError(error.message);
                    } finally {
                        // Reset button
                        deployBtn.disabled = false;
                        document.querySelector('.button-text').style.display = 'block';
                        document.querySelector('.button-spinner').style.display = 'none';
                    }
                }

                function showProgress(text) {
                    uploadProgress.style.display = 'block';
                    uploadResult.style.display = 'none';
                    progressText.textContent = text;
                    progressFill.style.width = '0%';
                }

                function updateProgress(percent, text) {
                    progressFill.style.width = percent + '%';
                    if (text) progressText.textContent = text;
                }

                function showSuccess(siteId, result) {
                    uploadProgress.style.display = 'none';
                    uploadResult.style.display = 'block';
                    uploadResult.className = 'upload-result result-success';

                    const indexFile = result.files.find(f => f.path === 'index.html');
                    const entityKey = result.indexTxHash || indexFile?.txHash || 'N/A';
                    const siteUrl = '/' + siteId + '/';
                    const explorerUrl = 'https://explorer.kaolin.holesky.golemdb.io/entity/' + encodeURIComponent(entityKey);

                    uploadResult.innerHTML = \`
                        <div style="font-size: 1.2rem; margin-bottom: 1rem;">
                            🎉 <strong>Site deployed successfully!</strong>
                        </div>
                        <div style="margin-bottom: 1rem;">
                            Your site is live at: <strong>\${siteId}.webdb.site</strong>
                        </div>
                        <div class="result-actions">
                            <a href="\${siteUrl}" target="_blank" class="result-button btn-open">🔗 Open Site</a>
                            <button onclick="copySiteUrl('\${siteId}.webdb.site')" class="result-button btn-copy">📋 Copy URL</button>
                            <a href="\${explorerUrl}" target="_blank" class="result-button btn-explorer">🔍 View on Explorer</a>
                        </div>
                        <div style="margin-top: 1rem; font-size: 0.9rem; color: #666;">
                            Entity ID: <code>\${entityKey}</code>
                        </div>
                    \`;
                }

                function showError(message) {
                    uploadProgress.style.display = 'none';
                    uploadResult.style.display = 'block';
                    uploadResult.className = 'upload-result result-error';
                    uploadResult.innerHTML = \`
                        <div style="font-size: 1.1rem; margin-bottom: 0.5rem;">
                            ❌ <strong>Upload failed</strong>
                        </div>
                        <div>\${message}</div>
                    \`;
                }

                function hideError() {
                    // You could add a global error display here if needed
                }

                // Utility functions
                function getFileIcon(filename) {
                    const ext = filename.split('.').pop().toLowerCase();
                    const icons = {
                        'html': '🌐', 'htm': '🌐',
                        'css': '🎨', 'js': '📜',
                        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️',
                        'zip': '📦'
                    };
                    return icons[ext] || '📄';
                }

                function formatFileSize(bytes) {
                    if (bytes === 0) return '0 Bytes';
                    const k = 1024;
                    const sizes = ['Bytes', 'KB', 'MB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
                }

                function copySiteUrl(url) {
                    navigator.clipboard.writeText('https://' + url).then(() => {
                        const btn = event.target;
                        const originalText = btn.textContent;
                        btn.textContent = '✅ Copied!';
                        setTimeout(() => btn.textContent = originalText, 2000);
                    });
                }

                // Smooth scroll to demo section
                function scrollToDemo() {
                    document.getElementById('demo').scrollIntoView({
                        behavior: 'smooth'
                    });
                }

                // Deploy options functionality
                function openWysiwygEditor() {
                    document.getElementById('wysiwygModal').style.display = 'flex';
                    document.body.style.overflow = 'hidden';
                }

                function closeWysiwygEditor() {
                    document.getElementById('wysiwygModal').style.display = 'none';
                    document.body.style.overflow = 'auto';
                }

                function showFileUpload() {
                    document.getElementById('fileUploadSection').style.display = 'block';
                    // Hide deploy methods section
                    document.querySelector('.deploy-methods').style.display = 'none';
                }

                function backToOptions() {
                    // Show deploy methods
                    document.querySelector('.deploy-methods').style.display = 'grid';
                    // Hide upload section
                    document.getElementById('fileUploadSection').style.display = 'none';
                    // Reset form
                    document.getElementById('deployForm').reset();
                    selectedFiles = [];
                    updateFileList();
                    updateDeployButton();
                }

                // Custom Modal Functions
                let promptCallback = null;

                function showAlert(message, title = 'Notice', type = '') {
                    document.getElementById('alertTitle').textContent = title;
                    document.getElementById('alertMessage').textContent = message;

                    const modal = document.getElementById('alertModal');
                    const content = modal.querySelector('.modal-content');
                    content.className = 'modal-content alert-modal ' + type;

                    modal.style.display = 'flex';
                    document.body.style.overflow = 'hidden';
                }

                function closeAlert() {
                    document.getElementById('alertModal').style.display = 'none';
                    document.body.style.overflow = 'auto';
                }

                function showPrompt(message, defaultValue = '', title = 'Input Required') {
                    return new Promise((resolve) => {
                        document.getElementById('promptTitle').textContent = title;
                        document.getElementById('promptMessage').textContent = message;
                        document.getElementById('promptInput').value = defaultValue;

                        promptCallback = resolve;

                        document.getElementById('promptModal').style.display = 'flex';
                        document.body.style.overflow = 'hidden';

                        // Focus input
                        setTimeout(() => {
                            document.getElementById('promptInput').focus();
                        }, 100);
                    });
                }

                function closePrompt() {
                    document.getElementById('promptModal').style.display = 'none';
                    document.body.style.overflow = 'auto';
                    if (promptCallback) promptCallback(null);
                }

                function submitPrompt() {
                    const value = document.getElementById('promptInput').value;
                    document.getElementById('promptModal').style.display = 'none';
                    document.body.style.overflow = 'auto';
                    if (promptCallback) promptCallback(value);
                }

                // Handle Enter key in prompt
                document.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') {
                        if (document.getElementById('promptModal').style.display === 'flex') {
                            submitPrompt();
                        } else if (document.getElementById('alertModal').style.display === 'flex') {
                            closeAlert();
                        }
                    }
                    if (e.key === 'Escape') {
                        if (document.getElementById('promptModal').style.display === 'flex') {
                            closePrompt();
                        } else if (document.getElementById('alertModal').style.display === 'flex') {
                            closeAlert();
                        }
                    }
                });

                // WYSIWYG Editor functionality
                function formatText(command) {
                    document.execCommand(command, false, null);
                    document.getElementById('wysiwygEditor').focus();
                }

                function insertHeading() {
                    document.execCommand('formatBlock', false, 'h1');
                    document.getElementById('wysiwygEditor').focus();
                }

                function insertParagraph() {
                    document.execCommand('formatBlock', false, 'p');
                    document.getElementById('wysiwygEditor').focus();
                }

                async function insertImage() {
                    const url = await showPrompt('Enter image URL:', '', 'Insert Image');
                    if (url) {
                        document.execCommand('insertImage', false, url);
                    }
                    document.getElementById('wysiwygEditor').focus();
                }

                async function insertLink() {
                    const url = await showPrompt('Enter link URL:', '', 'Insert Link');
                    if (url) {
                        document.execCommand('createLink', false, url);
                    }
                    document.getElementById('wysiwygEditor').focus();
                }

                async function insertButton() {
                    const text = await showPrompt('Enter button text:', 'Click me', 'Insert Button');
                    if (text) {
                        const html = \`<button style="background: #667eea; color: white; padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer;">\${text}</button>\`;
                        document.execCommand('insertHTML', false, html);
                    }
                    document.getElementById('wysiwygEditor').focus();
                }

                function changeTemplate(template) {
                    const editor = document.getElementById('wysiwygEditor');

                    const templates = {
                        landing: \`<h1>Welcome to My Site</h1>
                        <p>This is an amazing landing page built on the blockchain.</p>
                        <button style="background: #667eea; color: white; padding: 1rem 2rem; border: none; border-radius: 8px;">Get Started</button>\`,

                        gallery: \`<h1>NFT Gallery</h1>
                        <p>Discover unique digital art pieces in our collection.</p>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin: 2rem 0;">
                            <div style="aspect-ratio: 1; background: #f0f0f0; border-radius: 8px;"></div>
                            <div style="aspect-ratio: 1; background: #f0f0f0; border-radius: 8px;"></div>
                            <div style="aspect-ratio: 1; background: #f0f0f0; border-radius: 8px;"></div>
                        </div>\`,

                        portfolio: \`<h1>My Portfolio</h1>
                        <p>I'm a creator building amazing things on the blockchain.</p>
                        <h2>Projects</h2>
                        <ul>
                            <li>Project 1 - Description</li>
                            <li>Project 2 - Description</li>
                            <li>Project 3 - Description</li>
                        </ul>\`,

                        docs: \`<h1>Documentation</h1>
                        <h2>Getting Started</h2>
                        <p>Follow these steps to get started...</p>
                        <h2>API Reference</h2>
                        <p>Use these endpoints to interact with our service...</p>\`
                    };

                    if (templates[template]) {
                        editor.innerHTML = templates[template];
                    }
                }

                async function saveWysiwygSite() {
                    const siteId = document.getElementById('wysiwygSiteId').value;
                    const content = document.getElementById('wysiwygEditor').innerHTML;

                    if (!siteId) {
                        showAlert('Please enter a site ID', 'Site ID Required', 'error');
                        return;
                    }

                    try {
                        // Create HTML page with basic styling
                        const htmlContent = \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>\${siteId}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #333; }
        h1 { color: #2c3e50; }
        img { max-width: 100%; height: auto; }
        button { transition: transform 0.2s; }
        button:hover { transform: translateY(-2px); }
    </style>
</head>
<body>
\${content}
</body>
</html>\`;

                        // Create FormData and upload
                        const formData = new FormData();
                        const blob = new Blob([htmlContent], { type: 'text/html' });
                        formData.append('files', blob, 'index.html');

                        const response = await fetch('/api/upload/' + encodeURIComponent(siteId), {
                            method: 'POST',
                            body: formData
                        });

                        const result = await response.json();

                        if (response.ok) {
                            showAlert(\`Site deployed successfully! Visit: https://\${siteId}.webdb.site\`, 'Deployment Success', 'success');
                            closeWysiwygEditor();
                        } else {
                            showAlert('Upload failed: ' + (result.error || 'Unknown error'), 'Deployment Failed', 'error');
                        }

                    } catch (error) {
                        showAlert('Upload failed: ' + error.message, 'Deployment Failed', 'error');
                    }
                }

            </script>
        </div>

    <!-- WYSIWYG Editor Modal -->
    <div id="wysiwygModal" class="wysiwyg-modal" style="display: none;">
        <div class="wysiwyg-content">
            <div class="wysiwyg-header">
                <div class="wysiwyg-header-left">
                    <button class="btn btn-outline" onclick="closeWysiwygEditor()">← Back to Options</button>
                    <input type="text" id="wysiwygSiteId" placeholder="Enter site ID..." class="site-id-input">
                </div>
                <div class="wysiwyg-controls">
                    <button class="btn btn-secondary" onclick="closeWysiwygEditor()">✕ Close</button>
                    <button class="btn btn-primary" onclick="saveWysiwygSite()">💾 Save & Deploy</button>
                </div>
            </div>

            <div class="wysiwyg-toolbar">
                <button onclick="formatText('bold')" class="toolbar-btn">𝐁</button>
                <button onclick="formatText('italic')" class="toolbar-btn"><i>I</i></button>
                <button onclick="formatText('underline')" class="toolbar-btn"><u>U</u></button>
                <span class="toolbar-divider">|</span>
                <button onclick="insertHeading()" class="toolbar-btn">H1</button>
                <button onclick="insertParagraph()" class="toolbar-btn">P</button>
                <span class="toolbar-divider">|</span>
                <button onclick="insertImage()" class="toolbar-btn">🖼️</button>
                <button onclick="insertLink()" class="toolbar-btn">🔗</button>
                <span class="toolbar-divider">|</span>
                <button onclick="insertButton()" class="toolbar-btn">🔘</button>
                <span class="toolbar-divider">|</span>
                <select onchange="changeTemplate(this.value)" class="template-select">
                    <option value="">Choose Template</option>
                    <option value="landing">Landing Page</option>
                    <option value="gallery">NFT Gallery</option>
                    <option value="portfolio">Portfolio</option>
                    <option value="docs">Documentation</option>
                </select>
            </div>

            <div class="wysiwyg-editor" id="wysiwygEditor" contenteditable="true">
                <h1>Welcome to Your Site</h1>
                <p>Start editing by clicking here or use the toolbar above...</p>
            </div>
        </div>
    </div>

    <!-- Custom Modals -->
    <div id="alertModal" class="custom-modal" style="display: none;">
        <div class="modal-content alert-modal">
            <div class="modal-header">
                <h3 id="alertTitle">Notice</h3>
                <button onclick="closeAlert()" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p id="alertMessage"></p>
            </div>
            <div class="modal-footer">
                <button onclick="closeAlert()" class="btn btn-primary">OK</button>
            </div>
        </div>
    </div>

    <div id="confirmModal" class="custom-modal" style="display: none;">
        <div class="modal-content confirm-modal">
            <div class="modal-header">
                <h3 id="confirmTitle">Confirm</h3>
                <button onclick="closeConfirm()" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p id="confirmMessage"></p>
            </div>
            <div class="modal-footer">
                <button onclick="closeConfirm()" class="btn btn-secondary">Cancel</button>
                <button onclick="confirmAction()" class="btn btn-primary">Confirm</button>
            </div>
        </div>
    </div>

    <div id="promptModal" class="custom-modal" style="display: none;">
        <div class="modal-content prompt-modal">
            <div class="modal-header">
                <h3 id="promptTitle">Input Required</h3>
                <button onclick="closePrompt()" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p id="promptMessage"></p>
                <input type="text" id="promptInput" class="modal-input" placeholder="Enter value...">
            </div>
            <div class="modal-footer">
                <button onclick="closePrompt()" class="btn btn-secondary">Cancel</button>
                <button onclick="submitPrompt()" class="btn btn-primary">OK</button>
            </div>
        </div>
    </div>

    <!-- Footer -->
    <footer class="footer">
        <div class="container">
            <div class="footer-content">
                <div class="footer-section">
                    <h4>WebDB</h4>
                    <p>Deploy static sites on Golem DB</p>
                </div>
                <div class="footer-section">
                    <h4>Resources</h4>
                    <a href="#api">API docs</a>
                    <a href="/health" target="_blank">Service status</a>
                    <a href="https://explorer.kaolin.holesky.golemdb.io" target="_blank">Golem DB Explorer</a>
                </div>
                <div class="footer-section">
                    <h4>Community</h4>
                    <a href="https://github.com/golemfactory" target="_blank">GitHub</a>
                    <a href="https://golem.network" target="_blank">Golem Network</a>
                </div>
                <div class="footer-section">
                    <h4>Legal</h4>
                    <a href="#terms">Terms of Service</a>
                    <a href="#privacy">Privacy Policy</a>
                </div>
            </div>
            <div class="footer-bottom">
                <p>&copy; 2024 WebDB - Built for immutable web hosting and NFT assets</p>
            </div>
        </div>
    </footer>
</body>
</html>`;
}

export default {
  port: config.port,
  hostname: config.hostname,
  fetch: app.fetch,
};

console.log(`🚀 Gateway server starting on ${config.hostname}:${config.port}`);
console.log(`📡 DB-Chain RPC: ${config.dbChainRpcUrl}`);
console.log(`🌐 Domain: ${config.domain}`);