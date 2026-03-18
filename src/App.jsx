import { useState, useRef, useEffect } from "react";

const CONDITIONS = ["Deadstock", "Excellent", "Good", "Fair", "Worn"];
const EMPTY_FORM = {
  brand: "", model: "", colorway: "", size: "",
  purchasePrice: "", currentValue: "", condition: "Excellent",
  photo: null, photoUrl: "", barcode: "", styleId: ""
};

const STORAGE_KEY = "sole-catalog-sneakers";

function loadSneakers() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}

function saveSneakers(sneakers) {
  // Strip non-serializable photo File objects before saving
  const clean = sneakers.map(({ photo, ...s }) => s);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
}

async function readLabelImage(file, apiKey) {
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: base64 } },
          { type: "text", text: `This is a sneaker box label. Extract all visible information and return ONLY a JSON object with: brand, model, colorway, size (US), styleId (product/style code), barcode (UPC digits only). No markdown, just JSON. Example: {"brand":"Nike","model":"Air Max 95","colorway":"Black/Neon Yellow","size":"9.5","styleId":"IO9926 001","barcode":"198488545936"}` }
        ]
      }]
    })
  });
  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("No JSON returned");
  return JSON.parse(jsonMatch[0]);
}

async function lookupByCode(code, styleCode, apiKey) {
  const prompt = styleCode
    ? `Search the web for sneaker with style code "${styleCode}"${code ? ` (UPC: ${code})` : ""}. Return ONLY JSON: {"brand":"Nike","model":"Air Max 95","colorway":"Black/Neon Yellow","size":"","styleId":"${styleCode}"}. No markdown.`
    : `Search the web for sneaker UPC ${code}. Return ONLY JSON: {"brand":"Nike","model":"Air Force 1","colorway":"White","size":"","styleId":""}. No markdown.`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 512,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const jsonMatch = text.match(/\{[^}]+\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
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
    headers.forEach((h, i) => { for (const [key, aliases] of Object.entries(fieldMap)) { if (aliases.includes(h)) row[key] = vals[i] || ""; } });
    return row;
  }).filter(r => r.brand || r.model);
}

function conditionColor(c) {
  return { Deadstock: "#22c55e", Excellent: "#3b82f6", Good: "#f59e0b", Fair: "#f97316", Worn: "#ef4444" }[c] || "#999";
}

const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;

export default function SneakerCatalog() {
  const [sneakers, setSneakers] = useState(loadSneakers);
  const [view, setView] = useState("catalog");
  const [addMode, setAddMode] = useState("scan");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCondition, setFilterCondition] = useState("All");
  const [sortBy, setSortBy] = useState("newest");
  const [csvError, setCsvError] = useState("");
  const [scanStatus, setScanStatus] = useState("");
  const [scanFound, setScanFound] = useState(null);
  const [manualCode, setManualCode] = useState("");
  const [manualStyle, setManualStyle] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [labelPreview, setLabelPreview] = useState(null);
  const labelRef = useRef();
  const photoRef = useRef();
  const csvRef = useRef();

  // Persist to localStorage whenever sneakers change
  useEffect(() => { saveSneakers(sneakers); }, [sneakers]);

  const goBack = () => {
    setView("catalog"); setAddMode("scan"); setScanFound(null);
    setScanStatus(""); setLabelPreview(null); setEditingId(null); setForm(EMPTY_FORM);
  };

  const handleLabelScan = async (file) => {
    if (!file) return;
    setLabelPreview(URL.createObjectURL(file));
    setScanStatus("Reading label…"); setLookingUp(true);
    try {
      const result = await readLabelImage(file, API_KEY);
      setLookingUp(false);
      if (result && (result.brand || result.model)) {
        setScanFound(result); setForm(f => ({ ...f, ...result }));
        setScanStatus(""); setAddMode("form");
      } else {
        setScanStatus("⚠️ Couldn't read label. Fill in details manually.");
        setTimeout(() => setScanStatus(""), 4000); setAddMode("form");
      }
    } catch {
      setLookingUp(false);
      setScanStatus("⚠️ Error reading label. Try manual entry.");
      setTimeout(() => setScanStatus(""), 4000); setAddMode("form");
    }
  };

  const handleManualLookup = async () => {
    if (!manualCode.trim() && !manualStyle.trim()) return;
    setScanStatus("Searching…"); setLookingUp(true);
    try {
      const result = await lookupByCode(manualCode.trim(), manualStyle.trim(), API_KEY);
      setLookingUp(false);
      if (result && (result.brand || result.model)) {
        setScanFound(result); setForm(f => ({ ...f, ...result, barcode: manualCode.trim() || f.barcode }));
        setScanStatus(""); setAddMode("form");
      } else {
        setScanFound({ barcode: manualCode, styleId: manualStyle });
        setForm(f => ({ ...f, barcode: manualCode, styleId: manualStyle }));
        setScanStatus("⚠️ No match found. Fill in details manually.");
        setTimeout(() => setScanStatus(""), 4000); setAddMode("form");
      }
    } catch {
      setLookingUp(false); setScanStatus("⚠️ Lookup failed."); setTimeout(() => setScanStatus(""), 4000); setAddMode("form");
    }
  };

  const handleSneakerPhoto = (file) => {
    if (!file) return;
    setForm(f => ({ ...f, photo: file, photoUrl: URL.createObjectURL(file) }));
  };

  const handleCsv = (file) => {
    setCsvError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCsv(e.target.result);
      if (!parsed.length) { setCsvError("Couldn't parse file. Check column headers."); return; }
      setSneakers(prev => {
        const updated = [...parsed.map((s, i) => ({ ...s, id: Date.now() + i })), ...prev];
        saveSneakers(updated);
        return updated;
      });
    };
    reader.readAsText(file);
  };

  const addSneaker = () => {
    if (!form.brand || !form.model) return;
    setSneakers(prev => {
      const updated = editingId
        ? prev.map(s => s.id === editingId ? { ...form, id: editingId } : s)
        : [{ ...form, id: Date.now() }, ...prev];
      saveSneakers(updated);
      return updated;
    });
    setForm(EMPTY_FORM); setScanFound(null); setManualCode(""); setManualStyle("");
    setLabelPreview(null); setView("catalog"); setAddMode("scan"); setScanStatus(""); setEditingId(null);
  };

  const deleteSneaker = (id) => {
    setSneakers(prev => { const updated = prev.filter(s => s.id !== id); saveSneakers(updated); return updated; });
    setView("catalog");
  };

  const startEdit = (s) => {
    setForm({ ...s, photo: null });
    setEditingId(s.id); setScanFound(null); setLabelPreview(null); setScanStatus("");
    setAddMode("form"); setView("add");
  };

  const filtered = sneakers
    .filter(s => filterCondition === "All" || s.condition === filterCondition)
    .filter(s => { const q = search.toLowerCase(); return !q || s.brand.toLowerCase().includes(q) || s.model.toLowerCase().includes(q) || (s.colorway || "").toLowerCase().includes(q); })
    .sort((a, b) => sortBy === "brand" ? a.brand.localeCompare(b.brand) : sortBy === "value" ? (parseFloat(b.currentValue) || 0) - (parseFloat(a.currentValue) || 0) : b.id - a.id);

  const totalValue = sneakers.reduce((acc, s) => acc + (parseFloat(s.currentValue) || 0), 0);
  const totalPaid = sneakers.reduce((acc, s) => acc + (parseFloat(s.purchasePrice) || 0), 0);

  return (
    <div style={{ fontFamily: "'DM Sans','Helvetica Neue',Arial,sans-serif", background: "#fafaf8", minHeight: "100vh", color: "#111" }}>
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
        .drop-zone{border:2px dashed #d4d2cc;border-radius:12px;padding:28px 20px;text-align:center;cursor:pointer;transition:all .2s;background:#fafaf8}
        .drop-zone.over{border-color:#111;background:#f0efea} .drop-zone:hover{border-color:#aaa}
        .pulse{animation:pulse 1.4s infinite} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-thumb{background:#ddd;border-radius:3px}
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #e8e6e1", background: "#fff", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 22 }}>Sole</span>
            <span style={{ fontSize: 12, color: "#999", fontWeight: 500 }}>{sneakers.length} pairs</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {view !== "catalog" && <button className="btn btn-ghost" onClick={goBack}>← Back</button>}
            {view === "catalog" && <>
              <label className="btn btn-ghost" style={{ cursor: "pointer", display: "flex", alignItems: "center" }}>
                Import CSV <input ref={csvRef} type="file" accept=".csv,.tsv" style={{ display: "none" }} onChange={e => e.target.files[0] && handleCsv(e.target.files[0])} />
              </label>
              <button className="btn btn-primary" onClick={() => { setForm(EMPTY_FORM); setScanFound(null); setManualCode(""); setManualStyle(""); setLabelPreview(null); setAddMode("scan"); setScanStatus(""); setEditingId(null); setView("add"); }}>+ Add Sneaker</button>
            </>}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>

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
              <div style={{ color: "#aaa", fontSize: 14, marginBottom: 24 }}>{sneakers.length > 0 ? "Try a different search or filter" : "Scan a box label, add manually, or import a CSV"}</div>
              {!sneakers.length && <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <label className="btn btn-ghost" style={{ cursor: "pointer" }}>Import CSV<input type="file" accept=".csv" style={{ display: "none" }} onChange={e => e.target.files[0] && handleCsv(e.target.files[0])} /></label>
                <button className="btn btn-primary" onClick={() => { setForm(EMPTY_FORM); setAddMode("scan"); setView("add"); }}>+ Add Sneaker</button>
              </div>}
            </div>
          )}
        </>}

        {/* ── ADD / EDIT ── */}
        {view === "add" && (
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <h1 style={{ fontFamily: "'DM Serif Display',serif", fontSize: 28, marginBottom: 6 }}>{editingId ? "Edit Sneaker" : "Add Sneaker"}</h1>

            {addMode === "scan" && !editingId && <>
              <p style={{ color: "#888", fontSize: 14, marginBottom: 24 }}>Snap a photo of the box label — Claude will read the brand, model, colorway, size, and style code automatically.</p>
              <label style={{ display: "block", marginBottom: 16, cursor: "pointer" }}>
                <div style={{ background: "#111", color: "#fff", borderRadius: 14, padding: "24px 20px", textAlign: "center" }}>
                  {lookingUp ? <div className="pulse" style={{ fontSize: 14 }}>🔍 Reading label…</div>
                    : <><div style={{ fontSize: 36, marginBottom: 10 }}>🏷️</div><div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Scan Box Label</div><div style={{ fontSize: 13, opacity: .7 }}>Take a photo of the label on the side of the box</div></>}
                </div>
                <input ref={labelRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => e.target.files[0] && handleLabelScan(e.target.files[0])} />
              </label>
              {labelPreview && <div style={{ marginBottom: 16, borderRadius: 10, overflow: "hidden", border: "1px solid #e8e6e1" }}><img src={labelPreview} alt="label" style={{ width: "100%", maxHeight: 200, objectFit: "contain", background: "#f5f4f0" }} /></div>}
              {scanStatus && <div style={{ background: "#f5f4f0", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#555", marginBottom: 14 }} className={lookingUp ? "pulse" : ""}>{scanStatus}</div>}
              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0" }}>
                <div style={{ flex: 1, height: 1, background: "#e8e6e1" }} /><span style={{ fontSize: 12, color: "#aaa" }}>or enter codes manually</span><div style={{ flex: 1, height: 1, background: "#e8e6e1" }} />
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div><label className="lbl">UPC / Barcode</label><input className="inp" placeholder="198488545936" value={manualCode} onChange={e => setManualCode(e.target.value)} onKeyDown={e => e.key === "Enter" && handleManualLookup()} /></div>
                  <div><label className="lbl">Style Code</label><input className="inp" placeholder="IO9926 001" value={manualStyle} onChange={e => setManualStyle(e.target.value)} onKeyDown={e => e.key === "Enter" && handleManualLookup()} /></div>
                </div>
                <button className="btn btn-ghost" onClick={handleManualLookup} disabled={(!manualCode.trim() && !manualStyle.trim()) || lookingUp} style={{ width: "100%" }}>{lookingUp ? "Searching…" : "Look up"}</button>
              </div>
              <div style={{ textAlign: "center", marginTop: 16 }}>
                <button className="btn btn-ghost" onClick={() => setAddMode("form")} style={{ fontSize: 12, color: "#aaa", border: "none" }}>Skip — fill in manually</button>
              </div>
            </>}

            {(addMode === "form" || editingId) && <>
              {scanFound && !editingId && (
                <div style={{ background: scanFound.brand ? "#f0fdf4" : "#fffbeb", border: `1px solid ${scanFound.brand ? "#bbf7d0" : "#fde68a"}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: scanFound.brand ? "#166534" : "#92400e", marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
                  {scanFound.brand ? `✅ Found: ${scanFound.brand} ${scanFound.model}` : "⚠️ Not found — fill in details manually"}
                  <button className="btn" style={{ marginLeft: "auto", fontSize: 11, padding: "3px 10px", border: "1px solid currentColor", borderRadius: 6 }} onClick={() => { setScanFound(null); setForm(EMPTY_FORM); setAddMode("scan"); setScanStatus(""); setLabelPreview(null); }}>Re-scan</button>
                </div>
              )}
              <div style={{ display: "grid", gap: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div><label className="lbl">Brand *</label><input className="inp" placeholder="Nike, Adidas…" value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} /></div>
                  <div><label className="lbl">Model *</label><input className="inp" placeholder="Air Max 95…" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} /></div>
                </div>
                <div><label className="lbl">Colorway</label><input className="inp" placeholder="Black/Neon Yellow…" value={form.colorway} onChange={e => setForm(f => ({ ...f, colorway: e.target.value }))} /></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div><label className="lbl">Style ID</label><input className="inp" placeholder="IO9926 001" value={form.styleId} onChange={e => setForm(f => ({ ...f, styleId: e.target.value }))} /></div>
                  <div><label className="lbl">Size (US)</label><input className="inp" type="number" placeholder="9.5" value={form.size} onChange={e => setForm(f => ({ ...f, size: e.target.value }))} /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
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
                    onDrop={e => { e.preventDefault(); setDragOver(false); handleSneakerPhoto(e.dataTransfer.files[0]); }}
                    onClick={() => photoRef.current?.click()}>
                    {form.photoUrl ? <img src={form.photoUrl} alt="preview" style={{ height: 100, borderRadius: 8, objectFit: "contain" }} />
                      : <><div style={{ fontSize: 28, marginBottom: 8 }}>📷</div><div style={{ fontSize: 13, color: "#888" }}>Drop photo here or <span style={{ textDecoration: "underline" }}>browse</span></div></>}
                    <input ref={photoRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => handleSneakerPhoto(e.target.files[0])} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", paddingTop: 4 }}>
                  <button className="btn btn-ghost" onClick={goBack}>Cancel</button>
                  <button className="btn btn-primary" onClick={addSneaker} disabled={!form.brand || !form.model}>{editingId ? "Save Changes" : "Add to Collection"}</button>
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
                  {s.styleId && <div style={{ marginTop: 16, fontSize: 12, color: "#aaa" }}>Style: {s.styleId}</div>}
                  {s.barcode && <div style={{ marginTop: 4, fontSize: 12, color: "#ccc" }}>UPC: {s.barcode}</div>}
                  <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost" onClick={() => startEdit(s)}>Edit</button>
                    <button className="btn btn-ghost" style={{ color: "#ef4444", borderColor: "#fca5a5" }} onClick={() => deleteSneaker(s.id)}>Remove</button>
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
