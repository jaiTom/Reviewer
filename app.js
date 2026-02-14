const $ = (sel) => document.querySelector(sel);

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function shuffleInPlace(arr){
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }
function normalizeText(s){
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}
function setLog(msg, tone=""){
  const el = $("#log");
  el.innerHTML = msg ? `<span class="${tone}">${msg}</span>` : "";
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function downloadFile(filename, text){
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Session-only save */
const SESSION_KEY = "mcq_pdf_reviewer_v1";
function loadSession(){
  try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }catch{ return null; }
}
function saveSession(state){
  try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); }catch{}
}
function clearSession(){
  try{ sessionStorage.removeItem(SESSION_KEY); }catch{}
}

/* App state */
let parsedQuestions = [];
let quizQuestions = [];
let idx = 0;
let score = 0;
let answered = [];
let locked = false;
let autoNextTimer = null;

/* PDF extraction (PDF.js) */
async function extractTextFromPdf(file){
  const arrayBuffer = await file.arrayBuffer();

  if (window.pdfjsLib?.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js";
  }

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let allLines = [];

  for(let p = 1; p <= pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const textContent = await page.getTextContent();

    const rows = new Map();
    for(const it of textContent.items){
      const x = it.transform[4];
      const y = it.transform[5];
      const yKey = Math.round(y * 2) / 2;
      if(!rows.has(yKey)) rows.set(yKey, []);
      rows.get(yKey).push({ x, str: it.str });
    }

    const yKeys = [...rows.keys()].sort((a,b)=> b-a);
    for(const yKey of yKeys){
      const parts = rows.get(yKey).sort((a,b)=> a.x - b.x).map(o => o.str);
      const line = normalizeText(parts.join(" "));
      if(line) allLines.push(line);
    }

    allLines.push("");
  }

  return normalizeText(allLines.join("\n"));
}

/* Parse MCQs */
function parseMcqText(rawText){
  const text = normalizeText(rawText);

  let mainText = text;
  let answerKeyText = "";

  const keyMatch = text.match(/\n(?:answers?|answer key)\b[\s\S]*$/i);
  if(keyMatch){
    answerKeyText = keyMatch[0];
    mainText = text.slice(0, keyMatch.index).trim();
  }

  const blocks = [];
  const reStart = /(?:^|\n)\s*(\d{1,4})\s*(?:[.)-])\s+/g;

  let m, lastIdx = 0, lastNo = null;
  while((m = reStart.exec(mainText)) !== null){
    const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const qNo = parseInt(m[1], 10);

    if(lastNo !== null){
      const prev = mainText.slice(lastIdx, start).trim();
      if(prev) blocks.push({ number: lastNo, body: prev });
    }
    lastNo = qNo;
    lastIdx = start;
  }
  if(lastNo !== null){
    const tail = mainText.slice(lastIdx).trim();
    if(tail) blocks.push({ number: lastNo, body: tail });
  }
  if(blocks.length === 0 && mainText.length > 0){
    blocks.push({ number: 1, body: mainText });
  }

  const answerMap = new Map();
  if(answerKeyText){
    const lines = answerKeyText.split("\n").map(l => l.trim()).filter(Boolean);
    for(const line of lines){
      const mm = line.match(/^(\d{1,4})\s*[\).:-]?\s*([A-D])\b(?:\s*[-–—:]\s*(.+))?$/i);
      if(mm){
        const n = parseInt(mm[1], 10);
        answerMap.set(n, { letter: mm[2].toUpperCase(), exp: (mm[3]||"").trim() });
      }
    }
  }

  const out = [];
  for(const b of blocks){
    let body = b.body;
    let inlineAnswer = "";
    let inlineExplanation = "";

    const ansMatch = body.match(/\banswer\s*[:\-]\s*([A-D])\b/i);
    if(ansMatch){
      inlineAnswer = ansMatch[1].toUpperCase();
      body = body.replace(ansMatch[0], "").trim();
    }

    const expMatch = body.match(/\bexplanation\s*[:\-]\s*([\s\S]+)$/i);
    if(expMatch){
      inlineExplanation = expMatch[1].trim();
      body = body.replace(expMatch[0], "").trim();
    }

    const optRe = /(?:^|\n)\s*([A-D])\s*(?:[).:-])\s+/g;
    const optHits = [];
    let om;
    while((om = optRe.exec(body)) !== null){
      optHits.push({ idx: om.index, key: om[1].toUpperCase() });
    }

    let qText = body.trim();
    const options = [];

    if(optHits.length >= 2){
      const firstOptPos = optHits[0].idx + (body[optHits[0].idx] === "\n" ? 1 : 0);
      qText = body.slice(0, firstOptPos).trim();

      for(let i = 0; i < optHits.length; i++){
        const start = optHits[i].idx + (body[optHits[i].idx] === "\n" ? 1 : 0);
        const end = (i + 1 < optHits.length) ? optHits[i + 1].idx : body.length;
        const chunk = body.slice(start, end).trim();
        const kk = optHits[i].key;
        const cleaned = chunk.replace(new RegExp("^\\s*" + kk + "\\s*(?:[).:-])\\s+"), "").trim();
        if(cleaned) options.push({ key: kk, text: cleaned });
      }
    } else {
      continue;
    }

    const ak = answerMap.get(b.number);
    const answerKey = inlineAnswer || (ak ? ak.letter : "");
    const explanation = inlineExplanation || (ak ? ak.exp : "");

    out.push({ number: b.number, question: qText, options, answerKey, explanation });
  }

  return out.filter(q => q.question && q.options && q.options.length >= 3);
}

/* Quiz flow */
function prepareQuiz(){
  const shuffleQ = $("#togShuffleQ").checked;
  const shuffleO = $("#togShuffleO").checked;

  quizQuestions = deepClone(parsedQuestions);

  for(const q of quizQuestions){
    const letters = ["A","B","C","D","E","F"];
    q.options = q.options.map((o, i) => ({
      key: (o.key || letters[i] || String(i+1)).toUpperCase(),
      text: (o.text || "").trim()
    }));
    if(shuffleO) shuffleInPlace(q.options);
  }

  if(shuffleQ) shuffleInPlace(quizQuestions);

  idx = 0; score = 0; answered = []; locked = false;
  clearTimeout(autoNextTimer); autoNextTimer = null;
}

function updateKPIs(){
  $("#kpiParsed").textContent = String(parsedQuestions.length);
  $("#kpiQ").textContent = quizQuestions.length ? `${clamp(idx+1,0,quizQuestions.length)}/${quizQuestions.length}` : "0/0";
  $("#kpiScore").textContent = String(score);

  const pct = quizQuestions.length ? (idx / quizQuestions.length) * 100 : 0;
  $("#progressFill").style.width = `${clamp(pct,0,100)}%`;
}

function persistIfEnabled(){
  if(!$("#togSessionSave").checked) return;
  saveSession({
    parsedQuestions, quizQuestions, idx, score, answered,
    settings:{
      shuffleQ: $("#togShuffleQ").checked,
      shuffleO: $("#togShuffleO").checked,
      autoNext: $("#togAutoNext").checked,
      sessionSave: $("#togSessionSave").checked
    }
  });
}

function renderQuestion(){
  const q = quizQuestions[idx];
  if(!q) return;

  $("#quizEmpty").classList.add("hide");
  $("#resultArea").classList.add("hide");
  $("#quizArea").classList.remove("hide");
  $("#btnRestart").disabled = false;

  $("#qNo").textContent = `Q#${idx+1} (source #${q.number})`;
  $("#qMeta").textContent = q.answerKey ? `Answer key: ${q.answerKey}` : "Answer key: (missing)";
  $("#qText").textContent = q.question;

  const form = $("#optForm");
  form.innerHTML = "";

  q.options.forEach((o, i) => {
    const id = `opt_${idx}_${i}`;
    const label = document.createElement("label");
    label.className = "opt";
    label.setAttribute("for", id);

    label.innerHTML = `
      <input type="radio" name="opt" id="${id}" value="${o.key}">
      <div class="k">${o.key})</div>
      <div class="t">${escapeHtml(o.text)}</div>
    `;

    form.appendChild(label);
  });

  $("#btnSubmit").disabled = true;
  $("#btnNext").classList.add("hide");
  $("#feedback").classList.remove("show");
  $("#fbTag").className = "tag";
  $("#fbText").textContent = "";

  form.onchange = () => {
    if(locked) return;
    $("#btnSubmit").disabled = !form.querySelector('input[type="radio"]:checked');
  };

  updateKPIs();
  persistIfEnabled();
}

function showFeedback(isCorrect, chosenKey){
  const q = quizQuestions[idx];
  const correctKey = (q.answerKey || "").toUpperCase();

  [...$("#optForm").querySelectorAll(".opt")].forEach(lab => {
    const key = lab.querySelector("input").value;
    lab.classList.remove("correct","wrong");
    if(correctKey && key === correctKey) lab.classList.add("correct");
    if(key === chosenKey && chosenKey !== correctKey) lab.classList.add("wrong");
  });

  $("#feedback").classList.add("show");
  const tag = $("#fbTag");
  tag.className = "tag " + (isCorrect ? "good" : "bad");
  tag.textContent = isCorrect ? "Correct" : "Incorrect";

  const exp = q.explanation || "No explanation provided in the PDF text.";
  const ansLine = correctKey ? `Correct answer: ${correctKey}` : "Correct answer: (missing)";

  $("#fbText").innerHTML =
    `<div class="fbLine"><span class="mono">${escapeHtml(ansLine)}</span></div>` +
    `<div class="fbLine">${escapeHtml(exp)}</div>`;
}

function submitAnswer(){
  const q = quizQuestions[idx];
  const checked = $("#optForm").querySelector('input[type="radio"]:checked');
  if(!checked) return;

  locked = true;
  $("#btnSubmit").disabled = true;

  const chosenKey = checked.value.toUpperCase();
  const correctKey = (q.answerKey || "").toUpperCase();
  const isCorrect = correctKey && chosenKey === correctKey;

  answered[idx] = { chosenKey, isCorrect };
  if(isCorrect) score += 1;

  showFeedback(isCorrect, chosenKey);
  $("#btnNext").classList.remove("hide");

  updateKPIs();
  persistIfEnabled();

  if(isCorrect && $("#togAutoNext").checked){
    clearTimeout(autoNextTimer);
    autoNextTimer = setTimeout(nextQuestion, 1200);
  }
}

function nextQuestion(){
  clearTimeout(autoNextTimer);
  autoNextTimer = null;
  locked = false;
  idx += 1;

  if(idx >= quizQuestions.length) finishQuiz();
  else renderQuestion();
}

function finishQuiz(){
  $("#quizArea").classList.add("hide");
  $("#resultArea").classList.remove("hide");
  $("#progressFill").style.width = "100%";

  const total = quizQuestions.length;
  const pct = total ? Math.round((score/total)*100) : 0;
  $("#resultSummary").innerHTML = `You scored <b>${score}/${total}</b> (<b>${pct}%</b>).`;

  const list = $("#reviewList");
  list.innerHTML = "";

  quizQuestions.forEach((q, i) => {
    const a = answered[i] || { chosenKey:"(none)", isCorrect:false };
    const correct = q.answerKey || "(missing)";
    const exp = q.explanation || "No explanation provided.";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <h3>Q${i+1}: ${escapeHtml(q.question)}</h3>
      <div class="badge">${a.isCorrect ? "✅ Correct" : "❌ Wrong"} • Your: <span class="mono">${escapeHtml(a.chosenKey)}</span> • Correct: <span class="mono">${escapeHtml(correct)}</span></div>
      <p><b>Explanation:</b>\n${escapeHtml(exp)}</p>
    `;
    list.appendChild(div);
  });

  persistIfEnabled();
}

function tryRestoreSession(){
  const st = loadSession();
  if(!st || !Array.isArray(st.parsedQuestions)) return false;

  parsedQuestions = st.parsedQuestions || [];
  quizQuestions = st.quizQuestions || [];
  idx = st.idx || 0;
  score = st.score || 0;
  answered = st.answered || [];
  locked = false;

  if(st.settings){
    $("#togShuffleQ").checked = !!st.settings.shuffleQ;
    $("#togShuffleO").checked = !!st.settings.shuffleO;
    $("#togAutoNext").checked = !!st.settings.autoNext;
    $("#togSessionSave").checked = (st.settings.sessionSave !== false);
  }

  $("#btnStart").disabled = parsedQuestions.length === 0;
  $("#btnExportJson").disabled = parsedQuestions.length === 0;
  $("#btnRestart").disabled = quizQuestions.length === 0;

  updateKPIs();

  if(quizQuestions.length){
    if(idx >= quizQuestions.length) finishQuiz();
    else renderQuestion();
  } else if(parsedQuestions.length){
    $("#quizEmpty").innerHTML = `Session restored: <span class="mono">${parsedQuestions.length}</span> questions parsed. Click <span class="mono">Start Quiz</span>.`;
  }

  setLog(`Restored session with ${parsedQuestions.length} question(s).`, "okText");
  return true;
}

/* Wiring */
$("#btnParse").addEventListener("click", async () => {
  const file = $("#pdfFile").files?.[0];
  if(!file){ setLog("Choose a PDF first.", "warnText"); return; }

  setLog("Reading PDF text…", "warnText");
  try{
    const text = await extractTextFromPdf(file);
    parsedQuestions = parseMcqText(text);

    $("#btnStart").disabled = parsedQuestions.length === 0;
    $("#btnExportJson").disabled = parsedQuestions.length === 0;

    setLog(
      parsedQuestions.length ? `Parsed ${parsedQuestions.length} question(s). Ready to start.` : "Parsed 0 questions. Try paste mode.",
      parsedQuestions.length ? "okText" : "dangerText"
    );

    updateKPIs();
    persistIfEnabled();
  }catch(e){
    console.error(e);
    setLog("PDF read failed. Run via http://localhost (not file://).", "dangerText");
  }
});

$("#btnStart").addEventListener("click", () => {
  if(!parsedQuestions.length){ setLog("Parse something first.", "warnText"); return; }
  prepareQuiz();
  renderQuestion();
  setLog("", "");
});

$("#btnSubmit").addEventListener("click", submitAnswer);
$("#btnNext").addEventListener("click", nextQuestion);

$("#btnRestart").addEventListener("click", () => {
  if(!parsedQuestions.length) return;
  prepareQuiz();
  renderQuestion();
  setLog("Quiz restarted.", "okText");
});

$("#btnClearSession").addEventListener("click", () => {
  clearSession();
  parsedQuestions = []; quizQuestions = [];
  idx = 0; score = 0; answered = []; locked = false;

  $("#btnStart").disabled = true;
  $("#btnExportJson").disabled = true;
  $("#btnRestart").disabled = true;

  $("#quizArea").classList.add("hide");
  $("#resultArea").classList.add("hide");
  $("#quizEmpty").classList.remove("hide");
  $("#quizEmpty").textContent = "Session cleared. Upload and parse a PDF to begin.";

  updateKPIs();
  setLog("Temporary session cleared.", "okText");
});

$("#btnExportJson").addEventListener("click", () => {
  if(!parsedQuestions.length) return;
  downloadFile("parsed-mcqs.json", JSON.stringify(parsedQuestions, null, 2));
});

$("#btnPasteMode").addEventListener("click", () => $("#pasteBox").classList.toggle("hide"));
$("#btnClosePaste").addEventListener("click", () => $("#pasteBox").classList.add("hide"));

$("#btnParsePaste").addEventListener("click", () => {
  parsedQuestions = parseMcqText($("#pasteText").value || "");
  $("#btnStart").disabled = parsedQuestions.length === 0;
  $("#btnExportJson").disabled = parsedQuestions.length === 0;

  setLog(
    parsedQuestions.length ? `Parsed ${parsedQuestions.length} from pasted text.` : "Parsed 0 from pasted text.",
    parsedQuestions.length ? "okText" : "dangerText"
  );
  updateKPIs();
  persistIfEnabled();
});

$("#togSessionSave").addEventListener("change", () => {
  if(!$("#togSessionSave").checked){ clearSession(); setLog("Session saving disabled.", "warnText"); }
  else { persistIfEnabled(); setLog("Session saving enabled.", "okText"); }
});

(function init(){
  updateKPIs();
  if(!tryRestoreSession()){
    $("#quizEmpty").textContent = "Upload a PDF and parse it to start.";
  }
})();
