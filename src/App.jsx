import { useState, useRef, useEffect, useCallback } from "react";

const CONDITIONS = ["Deadstock", "Excellent", "Good", "Fair", "Worn"];
const EMPTY_FORM = {
  brand: "", model: "", colorway: "", size: "",
  purchasePrice: "", currentValue: "", condition: "Excellent", photo: null, photoUrl: "", barcode: ""
};

async function lookupBarcode(code) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Search the web for sneaker UPC barcode: ${code}. Find the exact sneaker this barcode belongs to. Return ONLY a raw JSON object with these fields: brand, model, colorway, size. No markdown, no explanation, just the JSON. Example: {"brand":"Nike","model":"Air Force 1 Low","colorway":"White/White","size":"10"}. If not found return {"brand":"","model":"","colorway":"","size":""}.`
        }]
      })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`API error ${response.status}: ${responseText}`);
    const data = JSON.parse(responseText);

    // Build messages for potential follow-up (web search results need a second pass)
    const messages = [
      { role: "user", content: `Search the web for sneaker UPC barcode: ${code}. Find the exact sneaker this barcode belongs to. Return ONLY a raw JSON object with these fields: brand, model, colorway, size. No markdown, no explanation, just the JSON. Example: {"brand":"Nike","model":"Air Force 1 Low","colorway":"White/White","size":"10"}. If not found return {"brand":"","model":"","colorway":"","size":""}.` },
      { role: "assistant", content: data.content }
    ];

    // If stopped for tool_use, send back tool results and get final answer
    if (data.stop_reason === "tool_use") {
      const toolResults = data.content
        .filter(b => b.type === "web_search_result" || b.type === "server_tool_use")
        .map(b => ({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(b.content || b.input || "") }));

      const followUp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [...messages, { role: "user", content: "Based on the search results, now return ONLY the JSON object with brand, model, colorway, size." }]
        })
      });
      const followData = await followUp.json();
      const text = (followData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const jsonMatch = text.match(/\{[^{}]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.brand || parsed.model) return { ...parsed, barcode: code };
      }
    } else {
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const jsonMatch = text.match(/\{[^{}]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.brand || parsed.model) return { ...parsed, barcode: code };
      }
    }
  } catch (e) {
    console.error("Lookup error:", e);
  }
  return null;
}

function parseCsv(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g, ""));
  const fieldMap = {
    brand: ["brand"], model: ["model", "name"], colorway: ["colorway", "color"],
    size: ["size"], purchasePrice: ["purchaseprice", "purchase", "buyprice", "paid"],
    currentValue: ["currentvalue", "value", "marketvalue"], condition: ["condition"]
  };
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const row = { ...EMPTY_FORM };
    headers.forEach((h, i) => {
      for (const [key, aliases] of Object.entries(fieldMap)) {
        if (aliases.includes(h)) row[key] = vals[i] || "";
      }
    });
    return row;
  }).filter(r => r.brand || r.model);
}

function conditionColor(c) {
  return { Deadstock: "#22c55e", Excellent: "#3b82f6", Good: "#f59e0b", Fair: "#f97316", Worn: "#ef4444" }[c] || "#999";
}

let ZXingLoaded = false;
async function loadZXing() {
  if (ZXingLoaded && window.ZXing) return window.ZXing;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/zxing-js/0.21.1/umd/index.min.js";
    s.onload = () => { ZXingLoaded = true; res(window.ZXing); };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

export default function SneakerCatalog() {
  const [sneakers, setSneakers] = useState([]);
  const [view, setView] = useState("catalog");
  const [addMode, setAddMode] = useState("scan");
  const [form, setForm] = useState(EMPTY_FORM);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCondition, setFilterCondition] = useState("All");
  const [sortBy, setSortBy] = useState("newest");
  const [csvError, setCsvError] = useState("");
  const [scanMode, setScanMode] = useState("idle");
  const [scanStatus, setScanStatus] = useState("");
  const [scanFound, setScanFound] = useState(null);
  const [manualCode, setManualCode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [camError, setCamError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const videoRef = useRef();
  const photoRef = useRef();
  const csvRef = useRef();
  const scannerRef = useRef(null);
  const streamRef = useRef(null);

  const stopCamera = useCallback(() => {
    if (scannerRef.current) {
      if (scannerRef.current.rafId) cancelAnimationFrame(scannerRef.current.rafId);
      else { try { scannerRef.current.reset(); } catch {} }
      scannerRef.current = null;
    }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const startCamera = async () => {
    setCamError(""); setScanStatus("Starting camera…"); setScanMode("camera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setScanStatus("Point camera at the barcode on the box…");

      // Try native BarcodeDetector first (Android Chrome, newer browsers)
      if ("BarcodeDetector" in window) {
        const detector = new window.BarcodeDetector({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"]
        });
        const scan = async () => {
          if (!streamRef.current) return;
          try {
            if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0) {
                stopCamera(); setScanMode("idle");
                doLookup(barcodes[0].rawValue);
                return;
              }
            }
          } catch {}
          scannerRef.current = { rafId: requestAnimationFrame(scan) };
        };
        scannerRef.current = { rafId: requestAnimationFrame(scan) };
      } else {
        // Fallback: ZXing
        const zx = await loadZXing();
        const hints = new Map();
        hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
          zx.BarcodeFormat.EAN_13, zx.BarcodeFormat.EAN_8,
          zx.BarcodeFormat.UPC_A, zx.BarcodeFormat.UPC_E, zx.BarcodeFormat.CODE_128
        ]);
        const reader = new zx.BrowserMultiFormatReader(hints);
        scannerRef.current = reader;
        reader.decodeFromStream(stream, videoRef.current, (result) => {
          if (result) { stopCamera(); setScanMode("idle"); doLookup(result.getText()); }
        });
      }
    } catch (e) {
      const msg = e.name === "NotAllowedError"
        ? "Camera permission denied. Please allow camera access in your browser settings and try again."
        : e.name === "NotFoundError"
        ? "No camera found on this device."
        : "Camera unavailable. Try uploading a photo or enter the barcode manually.";
      setCamError(msg);
      setScanMode("idle"); setScanStatus("");
    }
  };

  const decodeImage = async (file) => {
    setScanStatus("Reading barcode from image…"); setScanMode("upload");
    try {
      // Try native BarcodeDetector first
      if ("BarcodeDetector" in window) {
        const detector = new window.BarcodeDetector({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"]
        });
        const img = new Image();
        const url = URL.createObjectURL(file);
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const barcodes = await detector.detect(img);
        URL.revokeObjectURL(url);
        if (barcodes.length > 0) {
          setScanMode("idle"); setScanStatus("");
          doLookup(barcodes[0].rawValue);
          return;
        }
      }
      // Fallback: ZXing
      const zx = await loadZXing();
      const reader = new zx.BrowserMultiFormatReader();
      const url = URL.createObjectURL(file);
      const result = await reader.decodeFromImageUrl(url);
      URL.revokeObjectURL(url);
      setScanMode("idle"); setScanStatus("");
      doLookup(result.getText());
    } catch {
      setScanMode("idle");
      setScanStatus("⚠️ Couldn't read barcode. Try entering the number manually.");
      setTimeout(() => setScanStatus(""), 4000);
    }
  };

  const doLookup = async (code) => {
    setLookingUp(true); setScanStatus(`Looking up barcode ${code}…`);
    const result = await lookupBarcode(code);
    setLookingUp(false);
    if (result && (result.brand || result.model)) {
      setScanFound(result);
      setForm(f => ({ ...f, ...result }));
      setScanStatus("");
    } else {
      setScanFound({ barcode: code });
      setForm(f => ({ ...f, barcode: code }));
      setScanStatus(`⚠️ No product found for barcode ${code}. Fill in details manually.`);
      setTimeout(() => setScanStatus(""), 5000);
    }
    setAddMode("form");
  };

  const handleManualLookup = () => { if (manualCode.trim()) doLookup(manualCode.trim()); };

  const handlePhoto = (file) => {
    if (!file) return;
    setForm(f => ({ ...f, photo: file, photoUrl: URL.createObjectURL(file) }));
  };

  const handleCsv = (file) => {
    setCsvError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCsv(e.target.result);
      if (!parsed.length) { setCsvError("Couldn't parse file. Check column headers."); return; }
      setSneakers(prev => [...parsed.map((s, i) => ({ ...s, id: Date.now() + i })), ...prev]);
    };
    reader.readAsText(file);
  };

  const addSneaker = () => {
    if (!form.brand || !form.model) return;
    setSneakers(prev => [{ ...form, id: Date.now() }, ...prev]);
    setForm(EMPTY_FORM); setScanFound(null); setManualCode("");
    setView("catalog"); setAddMode("scan"); setScanStatus("");
  };

  const deleteSneaker = (id) => { setSneakers(prev => prev.filter(s => s.id !== id)); setView("catalog"); };

  const goBack = () => { stopCamera(); setView("catalog"); setAddMode("scan"); setScanFound(null); setScanStatus(""); setScanMode("idle"); };

  const filtered = sneakers
    .filter(s => filterCondition === "All" || s.condition === filterCondition)
    .filter(s => { const q = search.toLowerCase(); return !q || s.brand.toLowerCase().includes(q) || s.model.toLowerCase().includes(q) || (s.colorway || "").toLowerCase().includes(q); })
    .sort((a, b) => sortBy === "newest" ? b.id - a.id : sortBy === "brand" ? a.brand.localeCompare(b.brand) : (parseFloat(b.currentValue) || 0) - (parseFloat(a.currentValue) || 0));

  const totalValue = sneakers.reduce((acc, s) => acc + (parseFloat(s.currentValue) || 0), 0);
  const totalPaid = sneakers.reduce((acc, s) => acc + (parseFloat(s.purchasePrice) || 0), 0);

  const S = {
    page: { fontFamily: "'DM Sans','Helvetica Neue',Arial,sans-serif", background: "#fafaf8", minHeight: "100vh", color: "#111" },
    header: { borderBottom: "1px solid #e8e6e1", background: "#fff", position: "sticky", top: 0, zIndex: 100 },
    headerInner: { maxWidth: 1100, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 },
    wrap: { maxWidth: 1100, margin: "0 auto", padding: "32px 24px" },
    formWrap: { maxWidth: 560, margin: "0 auto" },
  };

  return (
    <div style={S.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Serif+Display&display=swap');
        *{box-sizing:border-box;margin:0;padding:0} input,select{font-family:inherit}
        .card{background:#fff;border:1px solid #e8e6e1;border-radius:12px;transition:box-shadow .2s,transform .2s;cursor:pointer}
        .card:hover{box-shadow:0 8px 32px rgba(0,0,0,.08);transform:translateY(-2px)}
        .btn{cursor:pointer;border:none;border-radius:8px;font-family:inherit;font-weight:500;transition:all .15s}
        .btn-primary{background:#111;color:#fff;padding:10px 22px;font-size:14px}
        .btn-primary:hover{background:#333} .btn-primary:disabled{background:#ccc;cursor:default}
        .btn-ghost{background:transparent;color:#666;padding:8px 16px;font-size:13px;border:1px solid #e8e6e1}
        .btn-ghost:hover{background:#f5f4f0;border-color:#ccc}
        .inp{width:100%;border:1px solid #e0deda;border-radius:8px;padding:10px 13px;font-size:14px;background:#fafaf8;outline:none;transition:border .15s}
        .inp:focus{border-color:#111;background:#fff}
        .lbl{font-size:12px;font-weight:500;color:#888;letter-spacing:.04em;text-transform:uppercase;display:block;margin-bottom:5px}
        .tag{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;color:#fff}
        .scan-tile{border:1.5px solid #e8e6e1;border-radius:14px;padding:20px 14px;text-align:center;cursor:pointer;transition:all .18s;background:#fff;user-select:none}
        .scan-tile:hover{border-color:#111;transform:translateY(-1px)}
        .scan-tile.on{border-color:#111;background:#111;color:#fff}
        .drop-zone{border:2px dashed #d4d2cc;border-radius:12px;padding:28px 20px;text-align:center;cursor:pointer;transition:all .2s;background:#fafaf8}
        .drop-zone.over{border-color:#111;background:#f0efea} .drop-zone:hover{border-color:#aaa}
        .pulse{animation:pulse 1.4s infinite} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        video{width:100%;border-radius:12px;display:block;background:#000}
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-thumb{background:#ddd;border-radius:3px}
      `}</style>

      {/* Header */}
      <div style={S.header}>
        <div style={S.headerInner}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 22 }}>Sole</span>
            <span style={{ fontSize: 12, color: "#999", fontWeight: 500 }}>{sneakers.length} pairs</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {view !== "catalog" && <button className="btn btn-ghost" onClick={goBack}>← Back</button>}
            {view === "catalog" && <>
              <label className="btn btn-ghost" style={{ cursor: "pointer", display: "flex", alignItems: "center" }}>
                Import CSV
                <input ref={csvRef} type="file" accept=".csv,.tsv" style={{ display: "none" }} onChange={e => e.target.files[0] && handleCsv(e.target.files[0])} />
              </label>
              <button className="btn btn-primary" onClick={() => { setForm(EMPTY_FORM); setScanFound(null); setManualCode(""); setAddMode("scan"); setScanStatus(""); setScanMode("idle"); setView("add"); }}>+ Add Sneaker</button>
            </>}
          </div>
        </div>
      </div>

      <div style={S.wrap}>

        {/* ── CATALOG ── */}
        {view === "catalog" && <>
          {sneakers.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 32 }}>
              {[{ l: "Collection", v: `${sneakers.length} pairs` }, { l: "Total Paid", v: totalPaid ? `$${totalPaid.toLocaleString()}` : "—" }, { l: "Est. Value", v: totalValue ? `$${totalValue.toLocaleString()}` : "—" }].map(({ l, v }) => (
                <div key={l} style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 12, padding: "20px 24px" }}>
                  <div style={{ fontSize: 11, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>{l}</div>
                  <div style={{ fontSize: 24, fontFamily: "'DM Serif Display',serif" }}>{v}</div>
                </div>
              ))}
            </div>
          )}
          {sneakers.length > 0 && (
            <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
              <input className="inp" placeholder="Search brand, model, colorway…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 280, flex: "1 1 200px" }} />
              <select className="inp" value={filterCondition} onChange={e => setFilterCondition(e.target.value)} style={{ width: "auto" }}>
                <option>All</option>{CONDITIONS.map(c => <option key={c}>{c}</option>)}
              </select>
              <select className="inp" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ width: "auto" }}>
                <option value="newest">Newest first</option>
                <option value="brand">Brand A–Z</option>
                <option value="value">Highest value</option>
              </select>
            </div>
          )}
          {csvError && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 16 }}>{csvError}</div>}

          {filtered.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 18 }}>
              {filtered.map(s => (
                <div key={s.id} className="card" onClick={() => { setSelected(s); setView("detail"); }}>
                  <div style={{ aspectRatio: "4/3", background: "#f5f4f0", borderRadius: "12px 12px 0 0", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {s.photoUrl ? <img src={s.photoUrl} alt={s.model} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.2"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2"/></svg>}
                  </div>
                  <div style={{ padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>{s.brand}</div>
                    <div style={{ fontSize: 15, fontWeight: 600, margin: "3px 0 2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.model}</div>
                    {s.colorway && <div style={{ fontSize: 12, color: "#888", marginBottom: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.colorway}</div>}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="tag" style={{ background: conditionColor(s.condition) }}>{s.condition}</span>
                      <div style={{ textAlign: "right" }}>
                        {s.currentValue && <div style={{ fontSize: 14, fontWeight: 600 }}>${parseFloat(s.currentValue).toLocaleString()}</div>}
                        {s.size && <div style={{ fontSize: 11, color: "#aaa" }}>US {s.size}</div>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "80px 20px" }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>👟</div>
              <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 24, marginBottom: 8 }}>{sneakers.length > 0 ? "No matches" : "Your collection awaits"}</div>
              <div style={{ color: "#aaa", fontSize: 14, marginBottom: 24 }}>{sneakers.length > 0 ? "Try a different search or filter" : "Scan a barcode, add manually, or import a CSV"}</div>
              {!sneakers.length && <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <label className="btn btn-ghost" style={{ cursor: "pointer" }}>Import CSV<input type="file" accept=".csv" style={{ display: "none" }} onChange={e => e.target.files[0] && handleCsv(e.target.files[0])} /></label>
                <button className="btn btn-primary" onClick={() => { setForm(EMPTY_FORM); setAddMode("scan"); setView("add"); }}>+ Add Sneaker</button>
              </div>}
            </div>
          )}
        </>}

        {/* ── ADD ── */}
        {view === "add" && (
          <div style={S.formWrap}>
            <h1 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 28, marginBottom: 6 }}>Add Sneaker</h1>

            {addMode === "scan" && <>
              <p style={{ color: "#888", fontSize: 14, marginBottom: 24 }}>Scan the barcode on the sneaker box to auto-fill details.</p>

              {/* 3 tiles */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
                <div className={`scan-tile${scanMode === "camera" ? " on" : ""}`}
                  onClick={scanMode === "camera" ? () => { stopCamera(); setScanMode("idle"); setScanStatus(""); } : startCamera}>
                  <div style={{ fontSize: 30, marginBottom: 8 }}>📷</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{scanMode === "camera" ? "Stop" : "Camera"}</div>
                  <div style={{ fontSize: 11, opacity: .6, marginTop: 3 }}>Live scan</div>
                </div>
                <label className="scan-tile" style={{ cursor: "pointer" }}>
                  <div style={{ fontSize: 30, marginBottom: 8 }}>🖼️</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Photo</div>
                  <div style={{ fontSize: 11, color: "#aaa", marginTop: 3 }}>Upload label</div>
                  <input type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => e.target.files[0] && decodeImage(e.target.files[0])} />
                </label>
                <div className={`scan-tile${scanMode === "manual" ? " on" : ""}`} onClick={() => setScanMode(m => m === "manual" ? "idle" : "manual")}>
                  <div style={{ fontSize: 30, marginBottom: 8 }}>⌨️</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Manual</div>
                  <div style={{ fontSize: 11, opacity: .6, marginTop: 3 }}>Type code</div>
                </div>
              </div>

              {scanMode === "camera" && (
                <div style={{ marginBottom: 16 }}>
                  <video ref={videoRef} autoPlay playsInline muted />
                </div>
              )}

              {scanMode === "manual" && (
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <input className="inp" placeholder="Enter UPC / barcode number…" value={manualCode}
                    onChange={e => setManualCode(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleManualLookup()} />
                  <button className="btn btn-primary" onClick={handleManualLookup} disabled={!manualCode.trim() || lookingUp} style={{ whiteSpace: "nowrap" }}>
                    {lookingUp ? "…" : "Look up"}
                  </button>
                </div>
              )}

              {(scanStatus || lookingUp) && (
                <div style={{ background: "#f5f4f0", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#555", marginBottom: 14 }} className={lookingUp ? "pulse" : ""}>
                  {lookingUp ? `🔍 ${scanStatus}` : scanStatus}
                </div>
              )}
              {camError && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#dc2626", marginBottom: 14 }}>{camError}</div>}

              <div style={{ textAlign: "center", marginTop: 10 }}>
                <button className="btn btn-ghost" onClick={() => setAddMode("form")}>Skip scan — fill in manually</button>
              </div>
            </>}

            {addMode === "form" && <>
              {scanFound && (
                <div style={{ background: scanFound.brand ? "#f0fdf4" : "#fffbeb", border: `1px solid ${scanFound.brand ? "#bbf7d0" : "#fde68a"}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: scanFound.brand ? "#166534" : "#92400e", marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
                  {scanFound.brand ? `✅ Found: ${scanFound.brand} ${scanFound.model}` : `⚠️ Barcode ${scanFound.barcode} — fill in details manually`}
                  <button className="btn" style={{ marginLeft: "auto", fontSize: 11, padding: "3px 10px", border: "1px solid currentColor", borderRadius: 6 }}
                    onClick={() => { setScanFound(null); setForm(EMPTY_FORM); setAddMode("scan"); setScanMode("idle"); setScanStatus(""); }}>
                    Re-scan
                  </button>
                </div>
              )}
              <div style={{ display: "grid", gap: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div><label className="lbl">Brand *</label><input className="inp" placeholder="Nike, Adidas…" value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} /></div>
                  <div><label className="lbl">Model *</label><input className="inp" placeholder="Air Max 1…" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} /></div>
                </div>
                <div><label className="lbl">Colorway</label><input className="inp" placeholder="Bred, Triple White…" value={form.colorway} onChange={e => setForm(f => ({ ...f, colorway: e.target.value }))} /></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                  <div><label className="lbl">Size (US)</label><input className="inp" type="number" placeholder="10.5" value={form.size} onChange={e => setForm(f => ({ ...f, size: e.target.value }))} /></div>
                  <div><label className="lbl">Paid ($)</label><input className="inp" type="number" placeholder="120" value={form.purchasePrice} onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))} /></div>
                  <div><label className="lbl">Value ($)</label><input className="inp" type="number" placeholder="200" value={form.currentValue} onChange={e => setForm(f => ({ ...f, currentValue: e.target.value }))} /></div>
                </div>
                <div>
                  <label className="lbl">Condition</label>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {CONDITIONS.map(c => (
                      <button key={c} className="btn" onClick={() => setForm(f => ({ ...f, condition: c }))}
                        style={{ padding: "7px 14px", fontSize: 13, border: `1.5px solid ${form.condition === c ? conditionColor(c) : "#e0deda"}`, background: form.condition === c ? conditionColor(c) : "#fff", color: form.condition === c ? "#fff" : "#555", borderRadius: 20 }}>
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="lbl">Sneaker Photo</label>
                  <div className={`drop-zone${dragOver ? " over" : ""}`}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); handlePhoto(e.dataTransfer.files[0]); }}
                    onClick={() => photoRef.current?.click()}>
                    {form.photoUrl
                      ? <img src={form.photoUrl} alt="preview" style={{ height: 100, borderRadius: 8, objectFit: "contain" }} />
                      : <><div style={{ fontSize: 28, marginBottom: 8 }}>📷</div><div style={{ fontSize: 13, color: "#888" }}>Drop photo here or <span style={{ textDecoration: "underline" }}>browse</span></div></>}
                    <input ref={photoRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => handlePhoto(e.target.files[0])} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", paddingTop: 4 }}>
                  <button className="btn btn-ghost" onClick={goBack}>Cancel</button>
                  <button className="btn btn-primary" onClick={addSneaker} disabled={!form.brand || !form.model}>Add to Collection</button>
                </div>
              </div>
            </>}
          </div>
        )}

        {/* ── DETAIL ── */}
        {view === "detail" && selected && (() => {
          const s = sneakers.find(x => x.id === selected.id) || selected;
          const gain = s.currentValue && s.purchasePrice ? parseFloat(s.currentValue) - parseFloat(s.purchasePrice) : null;
          return (
            <div style={{ maxWidth: 700, margin: "0 auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, alignItems: "start" }}>
                <div style={{ background: "#f5f4f0", borderRadius: 16, aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                  {s.photoUrl ? <img src={s.photoUrl} alt={s.model} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2"/></svg>}
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{s.brand}</div>
                  <h2 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 28, lineHeight: 1.2, marginBottom: 6 }}>{s.model}</h2>
                  {s.colorway && <div style={{ color: "#777", fontSize: 15, marginBottom: 16 }}>{s.colorway}</div>}
                  <span className="tag" style={{ background: conditionColor(s.condition), marginBottom: 20, display: "inline-block" }}>{s.condition}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    {[
                      { l: "Size", v: s.size ? `US ${s.size}` : "—" },
                      { l: "Paid", v: s.purchasePrice ? `$${parseFloat(s.purchasePrice).toLocaleString()}` : "—" },
                      { l: "Est. Value", v: s.currentValue ? `$${parseFloat(s.currentValue).toLocaleString()}` : "—" },
                      { l: "Gain / Loss", v: gain !== null ? `${gain >= 0 ? "+" : ""}$${gain.toLocaleString()}` : "—", c: gain > 0 ? "#22c55e" : gain < 0 ? "#ef4444" : undefined },
                    ].map(({ l, v, c }) => (
                      <div key={l} style={{ background: "#f5f4f0", borderRadius: 10, padding: "12px 14px" }}>
                        <div style={{ fontSize: 10, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{l}</div>
                        <div style={{ fontSize: 18, fontWeight: 600, color: c || "#111" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {s.barcode && <div style={{ marginTop: 14, fontSize: 12, color: "#ccc" }}>UPC: {s.barcode}</div>}
                  <div style={{ marginTop: 20 }}>
                    <button className="btn btn-ghost" style={{ color: "#ef4444", borderColor: "#fca5a5" }} onClick={() => deleteSneaker(s.id)}>Remove from Collection</button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
