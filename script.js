import { removeBackground } from "https://esm.sh/@imgly/background-removal@1.7.0";

  // ---------- tema claro/escuro ----------
  const root = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const themeLabel = document.getElementById('themeLabel');

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    themeLabel.textContent = theme === 'dark' ? 'Modo Claro' : 'Modo Escuro';
    try { localStorage.setItem('traco-certo-theme', theme); } catch (e) {}
  }

  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('traco-certo-theme'); } catch (e) {}
    applyTheme(saved === 'light' ? 'light' : 'dark');
  })();

  themeToggle.addEventListener('click', () => {
    const current = root.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // ---------- ferramenta ----------
  const stage = document.getElementById('stage');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const developing = document.getElementById('developing');
  const developingImg = document.getElementById('developingImg');
  const processingLabel = document.getElementById('processingLabel');
  const result = document.getElementById('result');
  const svgTray = document.getElementById('svgTray');
  const thresholdSlider = document.getElementById('thresholdSlider');
  const preserveWhitesCheckbox = document.getElementById('preserveWhitesCheckbox');
  const thresholdVal = document.getElementById('thresholdVal');
  const downloadSvgBtn = document.getElementById('downloadSvgBtn');
  const downloadDxfBtn = document.getElementById('downloadDxfBtn');
  const resetBtn = document.getElementById('resetBtn');
  const toast = document.getElementById('toast');

  const MAX_DIM = 1800; // resolução de trabalho — mais alta preserva letras e detalhes finos

  let sourceCanvas = null;
  let currentSvgString = '';
  let currentBinCanvas = null;
  let sourceName = 'logotipo';
  let traceTimer = null;

  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function setState(state) {
    dropzone.style.display = state === 'idle' ? 'block' : 'none';
    developing.style.display = state === 'processing' ? 'block' : 'none';
    result.style.display = state === 'done' ? 'block' : 'none';
  }

  function resetAll() {
    sourceCanvas = null;
    currentSvgString = '';
    currentBinCanvas = null;
    fileInput.value = '';
    svgTray.innerHTML = '';
    preserveWhitesCheckbox.checked = false;
    setState('idle');
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('selecione um arquivo de imagem válido', true);
      return;
    }
    sourceName = (file.name || 'logotipo').replace(/\.[^.]+$/, '');
    developingImg.src = URL.createObjectURL(file);
    processingLabel.innerHTML = 'removendo fundo<span class="dots"></span>';
    setState('processing');
    await nextPaint();

    try {
      const skipRemoval = await alreadyHasTransparentBackground(file);
      let bgRemovedBlob;
      if (skipRemoval) {
        processingLabel.innerHTML = 'fundo já removido, aproveitando a imagem<span class="dots"></span>';
        await nextPaint();
        bgRemovedBlob = file;
      } else {
        bgRemovedBlob = await removeBackground(file, {
          model: 'isnet_fp16', // melhor qualidade de máscara disponível na biblioteca
          progress: () => {}
        });
      }
      processingLabel.innerHTML = 'vetorizando<span class="dots"></span>';
      await nextPaint();
      sourceCanvas = await blobToCanvas(bgRemovedBlob, MAX_DIM);
      await nextPaint();
      await traceCurrent();
      setState('done');
    } catch (err) {
      console.error(err);
      showToast('não foi possível processar essa imagem', true);
      setState('idle');
    }
  }

  function blobToCanvas(blob, maxDim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  // checa se a imagem enviada já veio sem fundo (transparência real já presente).
  // se já vier assim, NÃO rodamos a remoção de fundo de novo — porque o modelo de IA,
  // sem saber que um branco ou uma área clara faz parte do próprio desenho (e não do
  // fundo), pode apagar pedaços legítimos (letras finas, contornos, detalhes pequenos).
  async function alreadyHasTransparentBackground(file) {
    const probe = await blobToCanvas(file, 200); // amostra pequena, só para checar o alpha
    const w = probe.width, h = probe.height;
    const ctx = probe.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;

    // média de alpha nos quatro cantos (onde o fundo normalmente estaria)
    const cornerAlpha = (cx, cy) => {
      let sum = 0, n = 0;
      for (let y = cy; y < cy + 4 && y < h; y++) {
        for (let x = cx; x < cx + 4 && x < w; x++) {
          sum += data[(y * w + x) * 4 + 3];
          n++;
        }
      }
      return n ? sum / n : 255;
    };
    const avgCorners = (
      cornerAlpha(0, 0) + cornerAlpha(w - 4, 0) +
      cornerAlpha(0, h - 4) + cornerAlpha(w - 4, h - 4)
    ) / 4;

    // proporção geral de pixels não totalmente opacos
    let transparentCount = 0;
    const totalPixels = w * h;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) transparentCount++;
    }
    const transparentRatio = transparentCount / totalPixels;

    return avgCorners < 15 || transparentRatio > 0.01;
  }

  function binarize(canvas, threshold, preserveWhites) {
    const w = canvas.width, h = canvas.height;
    const src = canvas.getContext('2d').getImageData(0, 0, w, h);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const outCtx = out.getContext('2d');
    const outData = outCtx.createImageData(w, h);
    // pixel bem claro (perto do branco puro) e pouco saturado — se "preservar brancos
    // internos" estiver ligado, esse tipo de pixel vira vazio mesmo estando dentro da
    // área opaca, porque normalmente é um espaço em branco proposital do desenho
    // (ex.: linhas/formas brancas dentro de um brasão), não uma cor sólida como
    // amarelo/azul/verde (que continuam virando preto normalmente).
    const WHITE_CHANNEL_MIN = 225;
    for (let i = 0; i < src.data.length; i += 4) {
      const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2], alpha = src.data[i + 3];
      const isWhiteish = preserveWhites && r >= WHITE_CHANNEL_MIN && g >= WHITE_CHANNEL_MIN && b >= WHITE_CHANNEL_MIN;
      const isInk = alpha >= threshold && !isWhiteish;
      if (isInk) {
        outData.data[i] = 0; outData.data[i+1] = 0; outData.data[i+2] = 0; outData.data[i+3] = 255;
      } else {
        outData.data[i] = 255; outData.data[i+1] = 255; outData.data[i+2] = 255; outData.data[i+3] = 255;
      }
    }
    outCtx.putImageData(outData, 0, 0);
    return out;
  }

  function traceToBlackSVG(binCanvas) {
    const w = binCanvas.width, h = binCanvas.height;
    const imageData = binCanvas.getContext('2d').getImageData(0, 0, w, h);
    const options = {
      pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
      ltres: 0.5, qtres: 0.5, pathomit: 0,
      rightangleenhance: true, scale: 1, roundcoords: 2, strokewidth: 0
    };
    const rawSvg = window.ImageTracer.imagedataToSVG(imageData, options);
    const doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml');
    const svgEl = doc.documentElement;
    svgEl.querySelectorAll('path, rect, polygon, circle').forEach(el => {
      const fill = (el.getAttribute('fill') || '').toLowerCase().replace(/\s+/g, '');
      const isBlack = fill === 'rgb(0,0,0)' || fill === '#000000' || fill === '#000' || fill === 'black';
      if (!isBlack) el.remove();
    });
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('height', h);
    svgEl.removeAttribute('style');
    return new XMLSerializer().serializeToString(svgEl);
  }

  async function traceCurrent() {
    if (!sourceCanvas) return;
    const threshold = Number(thresholdSlider.value);
    const preserveWhites = preserveWhitesCheckbox.checked;
    currentBinCanvas = binarize(sourceCanvas, threshold, preserveWhites);
    currentSvgString = traceToBlackSVG(currentBinCanvas);
    svgTray.innerHTML = currentSvgString;
    const svgNode = svgTray.querySelector('svg');
    if (svgNode) {
      svgNode.style.animation = 'none';
      void svgNode.offsetWidth;
      svgNode.style.animation = '';
    }
  }

  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach(evt =>
    stage.addEventListener(evt, (e) => {
      e.preventDefault();
      if (dropzone.style.display !== 'none') stage.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    stage.addEventListener(evt, (e) => {
      e.preventDefault();
      stage.classList.remove('drag-over');
    })
  );
  stage.addEventListener('drop', (e) => {
    if (dropzone.style.display === 'none') return;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  thresholdSlider.addEventListener('input', () => {
    thresholdVal.textContent = thresholdSlider.value;
    clearTimeout(traceTimer);
    traceTimer = setTimeout(traceCurrent, 220);
  });

  preserveWhitesCheckbox.addEventListener('change', () => {
    traceCurrent();
  });

  downloadSvgBtn.addEventListener('click', () => {
    if (!currentSvgString) return;
    const blob = new Blob([currentSvgString], { type: 'image/svg+xml' });
    triggerDownload(blob, `${sourceName}-vetor.svg`);
    showToast('SVG baixado');
  });

  // ---------- amostragem de traçado para DXF ----------
  let samplerSvg = null, samplerPath = null;
  function ensureSampler() {
    if (samplerSvg) return;
    samplerSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    samplerSvg.setAttribute('style', 'position:absolute;left:-99999px;top:-99999px;width:2px;height:2px;overflow:hidden;');
    samplerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    samplerSvg.appendChild(samplerPath);
    document.body.appendChild(samplerSvg);
  }

  function sampleSubpath(dStr) {
    ensureSampler();
    samplerPath.setAttribute('d', dStr);
    const len = samplerPath.getTotalLength();
    if (!isFinite(len) || len <= 0) return [];
    const steps = Math.max(16, Math.min(800, Math.ceil(len / 1.5)));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const p = samplerPath.getPointAtLength((i / steps) * len);
      pts.push([p.x, p.y]);
    }
    return pts;
  }

  function formatNum(n) {
    return (Math.round(n * 1000) / 1000).toString();
  }

  function svgToDXF(svgMarkup, heightPx) {
    const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    const paths = [...doc.querySelectorAll('path')];
    const polylines = [];
    paths.forEach((p) => {
      const d = p.getAttribute('d') || '';
      const subDs = d.split(/(?=[Mm])/).map(s => s.trim()).filter(Boolean);
      subDs.forEach((sub) => {
        const pts = sampleSubpath(sub);
        if (pts.length >= 3) polylines.push(pts);
      });
    });
    const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC'];
    lines.push('0', 'SECTION', '2', 'ENTITIES');
    polylines.forEach((pts) => {
      lines.push('0', 'POLYLINE', '8', '0', '66', '1', '70', '1');
      pts.forEach(([x, y]) => {
        lines.push('0', 'VERTEX', '8', '0', '10', formatNum(x), '20', formatNum(heightPx - y));
      });
      lines.push('0', 'SEQEND');
    });
    lines.push('0', 'ENDSEC', '0', 'EOF');
    return lines.join('\n');
  }

  downloadDxfBtn.addEventListener('click', () => {
    if (!currentSvgString || !currentBinCanvas) return;
    try {
      const dxfText = svgToDXF(currentSvgString, currentBinCanvas.height);
      const blob = new Blob([dxfText], { type: 'application/dxf' });
      triggerDownload(blob, `${sourceName}-vetor.dxf`);
      showToast('DXF baixado');
    } catch (err) {
      console.error(err);
      showToast('falha ao gerar o DXF', true);
    }
  });

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  resetBtn.addEventListener('click', resetAll);
