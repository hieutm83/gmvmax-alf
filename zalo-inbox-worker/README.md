# Zalo inbox Worker

Dedicated production webhook for Zalo Bot messages. It validates and deduplicates incoming events, keeps only the latest message in a short burst, acknowledges valid TikTok links, and forwards analytics work to the main processing queue.

Deploy from the repository root:

```sh
npx wrangler queues create gmv-max-zalo-ingress
npx wrangler secret put ZALO_BOT_TOKEN --config zalo-inbox-worker/wrangler.toml
npx wrangler deploy --config zalo-inbox-worker/wrangler.toml
```
