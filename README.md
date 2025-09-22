# WebDB

Decentralized web hosting platform using Golem DB for blockchain-based file storage.

**Live Demo:** [webdb.online](https://webdb.online)

## Features

- Upload static websites and host them on the decentralized web
- Blockchain-based file storage using Golem DB
- Automatic subdomain generation for each site
- File size and site size limits for resource management
- 30-day TTL (Time To Live) for stored content

## Self-Hosting Deployment

### Prerequisites

- Docker and Docker Compose
- A server with a public IP address
- Domain name pointing to your server (optional but recommended)

### Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/m00npl/webdb.git
   cd webdb
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and configure:
   - `GOLEM_PRIVATE_KEY`: Your Ethereum private key for Golem DB transactions
   - `DOMAIN`: Your domain name (e.g., `yourdomain.com`)
   - `PORT`: Server port (default: 3000)
   - Other settings as needed

3. **Build and run with Docker Compose:**
   ```bash
   docker compose up -d --build
   ```

4. **Access your WebDB instance:**
   - Open `http://your-server-ip:3000` or `http://yourdomain.com:3000`

### Production Deployment

#### Using Docker Hub Image

1. **Pull the latest image:**
   ```bash
   docker pull moonplkr/webdb-gateway:latest
   ```

2. **Create production docker-compose.yml:**
   ```yaml
   version: '3.8'
   services:
     webdb:
       image: moonplkr/webdb-gateway:latest
       ports:
         - "3000:3000"
       environment:
         - PORT=3000
         - HOSTNAME=0.0.0.0
         - DOMAIN=your-domain.com
         - GOLEM_PRIVATE_KEY=your_private_key_here
         - GOLEM_RPC_URL=https://kaolin.holesky.golemdb.io/rpc
         - CORS_ORIGINS=*
       volumes:
         - webdb_storage:/tmp/webdb-storage
       restart: unless-stopped

   volumes:
     webdb_storage:
   ```

3. **Run in production:**
   ```bash
   docker compose up -d
   ```

#### Reverse Proxy Setup (Nginx)

For production, set up Nginx as a reverse proxy:

```nginx
server {
    listen 80;
    server_name yourdomain.com *.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `HOSTNAME` | Server hostname | 0.0.0.0 |
| `DOMAIN` | Base domain for sites | webdb.site |
| `GOLEM_PRIVATE_KEY` | Ethereum private key for Golem DB | Required |
| `GOLEM_RPC_URL` | Golem DB RPC endpoint | https://kaolin.holesky.golemdb.io/rpc |
| `CORS_ORIGINS` | CORS allowed origins | * |
| `MAX_FILE_SIZE` | Maximum file size in bytes | 2097152 (2MB) |
| `MAX_SITE_SIZE` | Maximum site size in bytes | 52428800 (50MB) |

### Building from Source

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Build the application:**
   ```bash
   bun run build
   ```

3. **Run in development:**
   ```bash
   bun run dev
   ```

4. **Build Docker image:**
   ```bash
   docker buildx build -t webdb-gateway .
   ```

### File Structure

```
webdb/
├── src/
│   ├── gateway.ts          # Main server and API
│   ├── file-storage.ts     # File storage with Golem DB
│   ├── golem-db-client.ts  # Golem DB client
│   └── types.ts           # TypeScript definitions
├── static/                # Static frontend files
├── Dockerfile            # Container definition
├── docker-compose.yml    # Docker Compose configuration
└── README.md            # This file
```

### API Endpoints

- `POST /upload` - Upload a site (ZIP file)
- `GET /:siteId/*` - Serve site files
- `GET /api/sites/:siteId` - Get site metadata

### Security Notes

- Always use environment variables for sensitive data
- Never commit private keys to version control
- Use HTTPS in production
- Consider firewall rules for your server

### Support

For issues and questions, please visit the [GitHub repository](https://github.com/m00npl/webdb).
