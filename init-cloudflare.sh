#!/bin/bash
# LinkedBot Cloudflare Resource Initialization Script

set -e

echo "🚀 Starting Cloudflare resource initialization for LinkedBot..."

# 1. Create D1 Database
echo "Creating D1 database: linkedbot..."
# Check if it exists or just create (wrangler create will error if exists, which is fine with set -e if we want to stop, 
# but maybe we should be more graceful)
npx wrangler d1 create linkedbot || echo "⚠️  D1 database might already exist."

# 2. Create R2 Bucket
echo "Creating R2 bucket: images..."
npx wrangler r2 bucket create images || echo "⚠️  R2 bucket might already exist."

# 3. Create KV Namespace
echo "Creating KV namespace: linkedbot-sse..."
# Capturing output to help user update wrangler.jsonc
KV_OUTPUT=$(npx wrangler kv namespace create "linkedbot-sse")
echo "$KV_OUTPUT"

# 4. Create Queues
echo "Creating Queues..."
npx wrangler queues create linkedbot-mailbox || echo "⚠️  Queue linkedbot-mailbox might already exist."
npx wrangler queues create linkedbot-dlq || echo "⚠️  Queue linkedbot-dlq might already exist."

echo ""
echo "✅ Initialization steps completed."
echo "------------------------------------------------"
echo "👉 NEXT STEPS:"
echo "1. Update your 'wrangler.jsonc' with the IDs shown above (especially for D1 and KV)."
echo "2. Run migrations: npx wrangler d1 execute linkedbot --remote --file=migrations/d1/0001_users.sql"
echo "   (Repeat for 0002 and 0003)"
echo "3. Set your secrets:"
echo "   npx wrangler secret put SECRET_KEY"
echo "   npx wrangler secret put JWT_SECRET"
echo "4. Finally, run: npm run deploy"
echo "------------------------------------------------"
