# TikTok GMV Max Report on Cloudflare

Du an chuyen runtime tu Google Apps Script sang **Cloudflare Workers Paid + D1 + Queues**. Giao dien trong `public/index.html` duoc port nguyen tu `apps-script/Index.html`, bao gom font Inter, CSS, the chi so, bang va popup.

## Kien truc

- **Workers + Static Assets**: web app va REST API.
- **Durable Object**: khoa refresh OAuth, tranh nhieu request dong thoi lam xoay/hong refresh token.
- **D1**: token da ma hoa, cache report, snapshot theo ngay/gio, webhook inbox va trang thai gui bao cao.
- **Queues**: xu ly webhook Zalo, bao cao theo gio va backup Google Sheets ngoai request web.
- **Cron Trigger**: chay 24 lan moi ngay, tu 01:00 den 24:00 theo `Asia/Bangkok`.
- **Google Sheets**: chi nhan backup cac ngay da ket thuc; khong con la database chinh.

## Tao tai nguyen Cloudflare

Yeu cau Node.js 22 va Wrangler da dang nhap. De dung `cpu_ms = 300000` cho cac bao cao lon, tai khoan can Workers Paid; cau hinh hien tai van deploy duoc tren Free voi gioi han CPU mac dinh.

```powershell
npm install
npx wrangler login
npx wrangler d1 create gmv-max-db
npx wrangler queues create gmv-max-tasks
npx wrangler queues create gmv-max-dead-letter
```

Thay `REPLACE_WITH_D1_DATABASE_ID` trong `wrangler.toml` bang `database_id` vua tao, sau do:

```powershell
npx wrangler d1 migrations apply gmv-max-db --remote
```

## Secrets

Tao tung secret, khong commit gia tri vao GitHub:

```powershell
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ZALO_BOT_TOKEN
npx wrangler secret put ZALO_GROUP_CHAT_ID
npx wrangler secret put ZALO_WEBHOOK_SECRET
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GOOGLE_BACKUP_SPREADSHEET_ID
npx wrangler secret put TIKTOK_SHOP_APP_KEY
npx wrangler secret put TIKTOK_SHOP_APP_SECRET
npx wrangler secret put TIKTOK_SHOP_SERVICE_ID
```

- `ADMIN_PASSWORD`: dat mot mat khau rieng, khong ghi gia tri that vao source code.
- `TOKEN_ENCRYPTION_KEY`: chuoi ngau nhien toi thieu 32 ky tu.
- Ba secret Google co the bo qua neu chua dung backup.
- Ba bien `TIKTOK_SHOP_*` la cau hinh rieng cho tab Phan tich doanh thu. Chung khong dung chung token Ads MCP.

Trong TikTok Shop Partner Center, cau hinh redirect URL chinh xac:

```text
https://tiktok-gmv-max-report.tolahatdoxanh.workers.dev/seller/auth/callback
```

Ung dung Seller can quyen doc thong tin shop va don hang (`seller.authorization.info`, `seller.order.info`).
- Spreadsheet backup can co tab ten `GMV_MAX_BACKUP` va duoc share quyen Editor cho service-account email.

## Deploy va ket noi TikTok

```powershell
npm run typecheck
npm test
npm run deploy
```

Mo URL Worker, bam ket noi TikTok va hoan tat OAuth mot lan. Token sau do duoc ma hoa trong D1; refresh duoc Durable Object thuc hien tu dong, khong phu thuoc trinh duyet hay may tinh dang bat.

## Webhook Zalo

Dang ky URL sau tai Zalo Bot Platform:

```text
https://TEN-WORKER.workers.dev/webhooks/zalo?secret=GIA_TRI_ZALO_WEBHOOK_SECRET
```

Webhook tra HTTP ngay sau khi ghi D1, sau do Queue xu ly. Queue cung gui bao cao ADS vao tung khung gio 01:00, 02:00, ... 24:00. Cac chi so Cost, SKU orders, Cost / order, Gross revenue va ROI duoc lay tu dung dong trong bang `Du lieu theo gio`, khong lay tong luy ke ca ngay. Neu mot nhom gui nhieu tin lien tiep, task cu se bi danh dau `SKIPPED` va chi tin moi nhat duoc tra loi. Link dung dang:

```text
@Bot ADS - ALF https://www.tiktok.com/@username/video/POST_ID
```

## GitHub Actions

1. Tao repository GitHub tu noi dung folder nay.
2. Them repository secrets `CLOUDFLARE_API_TOKEN` va `CLOUDFLARE_ACCOUNT_ID`.
3. Push branch `main`. Workflow `.github/workflows/deploy.yml` se typecheck, test, migrate D1 va deploy.

Cron nghiep vu nam trong Cloudflare, khong dung GitHub Actions schedule.

## Backup va khoi phuc

Luc 08:00, Queue nap lai du lieu ngay hom truoc, ghi mot dong JSON vao D1 `daily_metrics`, roi append sang Google Sheets. `ON CONFLICT ... DO NOTHING` dam bao ngay da luu khong bi ghi trung.

Du lieu chinh nam trong D1. Google Sheet chi la ban xuat/backup, co the bo qua ma web va Zalo van hoat dong.

## Phat trien local

Sao chep `.dev.vars.example` thanh `.dev.vars`, dien secret test, sau do:

```powershell
npm run db:migrate:local
npm run dev
```

OAuth callback local chi hoat dong neu TikTok chap nhan URL callback truy cap cong khai. De test OAuth, nen deploy mot Worker dev rieng.
