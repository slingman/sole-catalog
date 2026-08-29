# 👟 Sole — Sneaker Catalog

A clean, minimal sneaker collection tracker with barcode scanning, CSV import, and value tracking.

## Features
- 📷 Barcode scanning (camera, photo upload, or manual entry)
- 📊 CSV / spreadsheet import
- 💰 Purchase price vs. current value tracking
- 🏷️ Condition grading (Deadstock → Worn)
- 🔍 Search, filter, and sort your collection

## Getting Started

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
```
Fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `ANTHROPIC_API_KEY`.

`ANTHROPIC_API_KEY` has no `VITE_` prefix on purpose — it's read server-side
only (by `api/claude.js` in production, and by a matching dev-time proxy in
`vite.config.js`), so the key is never bundled into client code or visible
in the browser.

### 3. Run locally
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173)

### 4. Build for production
```bash
npm run build
```

## Deploy to Vercel (recommended)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project**
3. Import your GitHub repo
4. Leave all settings as default — Vercel auto-detects Vite and picks up
   `api/claude.js` as a serverless function automatically
5. In **Project Settings → Environment Variables**, add `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, and `ANTHROPIC_API_KEY`
6. Click **Deploy** ✅

Your app will be live at `https://sole-catalog.vercel.app` (or similar).

## CSV Import Format

Your spreadsheet should have these column headers (flexible naming):

| brand | model | colorway | size | purchaseprice | currentvalue | condition |
|-------|-------|----------|------|---------------|--------------|-----------|
| Nike  | Air Max 1 | Bred | 10.5 | 120 | 280 | Deadstock |

Accepted condition values: `Deadstock`, `Excellent`, `Good`, `Fair`, `Worn`
