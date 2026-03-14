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

### 2. Run locally
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173)

### 3. Build for production
```bash
npm run build
```

## Deploy to Vercel (recommended)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project**
3. Import your GitHub repo
4. Leave all settings as default — Vercel auto-detects Vite
5. Click **Deploy** ✅

Your app will be live at `https://sole-catalog.vercel.app` (or similar).

## CSV Import Format

Your spreadsheet should have these column headers (flexible naming):

| brand | model | colorway | size | purchaseprice | currentvalue | condition |
|-------|-------|----------|------|---------------|--------------|-----------|
| Nike  | Air Max 1 | Bred | 10.5 | 120 | 280 | Deadstock |

Accepted condition values: `Deadstock`, `Excellent`, `Good`, `Fair`, `Worn`
