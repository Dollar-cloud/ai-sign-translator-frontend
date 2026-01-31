(function () {
  'use strict';

  /* ========== DOM refs (set when DOM is ready) ========== */
  let video, canvas, ctx, cameraStatus, translationDisplay, historyList;
  let alphabetCards, numbersCards, wordsCards, signModal, modalTitle, signDemoViewer, signDescription, modalClose;

  /* ========== State ========== */
  let stream = null;
  let mediaPipeLoaded = false;
  let hands = null;
  let handsLegacy = null;
  let useLegacyHands = false;
  let faceLandmarker = null;
  let faceLandmarksList = [];
  let detectionActive = false;
  let detectionPaused = false;
  let landmarksVisible = true;
  let lastHandFrame = 0;
  let mockWordIndex = 0;
  const MOCK_WORDS = ['Hello', 'Yes', 'No', 'Thank you', 'Please', 'Help', 'Water', 'Food', 'Good', 'Bad'];

  /* ========== Dark mode ========== */
  function initTheme() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    else document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    syncDarkModeCheckboxes();
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    syncDarkModeCheckboxes();
  }

  function syncDarkModeCheckboxes() {
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const isDark = theme === 'dark';
    document.querySelectorAll('#dark-mode-toggle, .dark-mode-toggle').forEach(el => {
      if (el.classList) el.classList.toggle('active', isDark);
    });
    const toggleLandmarks = document.getElementById('toggle-landmarks');
    const toggleDark = document.getElementById('toggle-dark-mode');
    if (toggleDark) toggleDark.checked = isDark;
  }

  /* ========== Camera logic ========== */
  function showCameraOverlay(show) {
    var overlay = document.getElementById('camera-cta-overlay');
    if (overlay) overlay.classList.toggle('hidden', !show);
  }

  async function startCamera() {
    if (stream) return;
    setStatus('Camera starting… Your browser will ask for permission.');
    showCameraOverlay(false);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
      video.srcObject = stream;
      await video.play();
      resizeCanvas();
      setStatus('No hand detected');
      showCameraOverlay(false);
      document.getElementById('btn-start-camera').disabled = true;
      document.getElementById('btn-stop-camera').disabled = false;
      var inlineBtn = document.getElementById('btn-start-camera-inline');
      if (inlineBtn) inlineBtn.disabled = true;
    } catch (e) {
      setStatus('Camera error: ' + (e.message || 'Permission denied'));
      showCameraOverlay(true);
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    detectionActive = false;
    setStatus('Ready — click Start Camera to begin');
    showCameraOverlay(true);
    document.getElementById('btn-start-camera').disabled = false;
    document.getElementById('btn-stop-camera').disabled = true;
    document.getElementById('btn-start-detection').disabled = false;
    document.getElementById('btn-pause').disabled = true;
    var inlineBtn = document.getElementById('btn-start-camera-inline');
    if (inlineBtn) inlineBtn.disabled = false;
    lastHandFrame = 0;
  }

  function setStatus(text, className = '') {
    cameraStatus.textContent = text;
    cameraStatus.className = 'camera-status' + (className ? ' ' + className : '');
  }

  function resizeCanvas() {
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  /* ========== Hand detection (MediaPipe HandLandmarker – tasks-vision) ========== */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = reject;
      document.body.appendChild(s);
    });
  }

  function loadMediaPipe() {
    if (mediaPipeLoaded) return Promise.resolve();
    return loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.js')
      .then(function () { mediaPipeLoaded = true; })
      .catch(function () { mediaPipeLoaded = false; });
  }

  async function getVisionResolver() {
    await loadMediaPipe();
    if (typeof FilesetResolver === 'undefined') return null;
    return FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
  }

  async function initHands() {
    if (hands) return hands;
    if (handsLegacy) return handsLegacy;
    var vision = await getVisionResolver();
    if (vision && typeof HandLandmarker !== 'undefined') {
      try {
        hands = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
          },
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          runningMode: 'VIDEO'
        });
        useLegacyHands = false;
        return hands;
      } catch (e) {
        console.warn('HandLandmarker init failed:', e);
      }
    }
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
      if (typeof Hands !== 'undefined') {
        handsLegacy = new Hands({
          locateFile: function (file) { return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file; }
        });
        handsLegacy.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        handsLegacy.onResults(function (results) {
          if (!detectionActive || detectionPaused) return;
          var lmList = results.multiHandLandmarks || [];
          var handList = (results.multiHandedness || []).map(function (h) { return [{ categoryName: h.label }]; });
          onHandResults(lmList, handList);
        });
        useLegacyHands = true;
        return handsLegacy;
      }
    } catch (e) {
      console.warn('Legacy Hands init failed:', e);
    }
    return null;
  }

  async function initFace() {
    if (faceLandmarker) return faceLandmarker;
    var vision = await getVisionResolver();
    if (!vision || typeof FaceLandmarker === 'undefined') return null;
    try {
      faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
        },
        runningMode: 'VIDEO',
        numFaces: 1
      });
      return faceLandmarker;
    } catch (e) {
      console.warn('FaceLandmarker init failed:', e);
      return null;
    }
  }

  function onHandResults(landmarksList, handednessList) {
    if (!detectionActive || detectionPaused) return;
    drawLandmarks(landmarksList || [], handednessList || []);
    if (landmarksList && landmarksList.length > 0) {
      setStatus('Hand detected', 'detected');
      lastHandFrame = Date.now();
      var landmarks = landmarksList[0];
      extractAndSendLandmarks(landmarks);
      requestMockTranslation(landmarks);
    } else {
      setStatus('No hand detected');
    }
  }

  var HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];

  function drawHandSkeleton(landmarksList, handednessList) {
    if (!landmarksVisible || !ctx || !canvas.width) return;
    if (!landmarksList || !landmarksList.length) return;
    for (var i = 0; i < landmarksList.length; i++) {
      var landmarks = landmarksList[i];
      var handCat = handednessList && handednessList[i];
      var catName = (handCat && handCat[0] && handCat[0].categoryName) || (handCat && handCat.categoryName) || '';
      var isRight = catName === 'Right';
      ctx.lineWidth = 3;
      ctx.strokeStyle = isRight ? '#22C55E' : '#F59E0B';
      for (var c = 0; c < HAND_CONNECTIONS.length; c++) {
        var a = HAND_CONNECTIONS[c][0];
        var b = HAND_CONNECTIONS[c][1];
        if (a < landmarks.length && b < landmarks.length) {
          var ax = landmarks[a].x * canvas.width;
          var ay = landmarks[a].y * canvas.height;
          var bx = landmarks[b].x * canvas.width;
          var by = landmarks[b].y * canvas.height;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
      ctx.fillStyle = isRight ? '#22C55E' : '#F59E0B';
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      for (var j = 0; j < landmarks.length; j++) {
        var lm = landmarks[j];
        var x = lm.x * canvas.width;
        var y = lm.y * canvas.height;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  function drawLandmarks(landmarksList, handednessList) {
    if (!ctx || !canvas.width) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (faceLandmarksList && faceLandmarksList.length > 0) {
      ctx.strokeStyle = '#06B6D4';
      ctx.fillStyle = '#06B6D4';
      ctx.lineWidth = 1;
      for (var f = 0; f < faceLandmarksList.length; f++) {
        var pts = faceLandmarksList[f];
        if (!pts) continue;
        for (var p = 0; p < pts.length; p++) {
          var l = pts[p];
          if (l && typeof l.x === 'number') {
            var x = l.x * canvas.width;
            var y = l.y * canvas.height;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    if (landmarksVisible && landmarksList && landmarksList.length) {
      drawHandSkeleton(landmarksList, handednessList);
    }
    ctx.restore();
  }

  function extractAndSendLandmarks(landmarks) {
    var data = [];
    for (var i = 0; i < landmarks.length; i++) {
      data.push({ x: landmarks[i].x, y: landmarks[i].y, z: landmarks[i].z });
    }
    sendLandmarksToBackend(data);
  }

  /* ========== Backend integration placeholder ========== */
  function sendLandmarksToBackend(landmarks) {
    // Placeholder for API / WebSocket integration
    // Example: fetch('/api/translate', { method: 'POST', body: JSON.stringify({ landmarks }) })
    // Example: ws.send(JSON.stringify({ type: 'landmarks', data: landmarks }))
  }

  /* ========== Mock translation (no backend) ========== */
  let mockTranslationTimeout = null;

  function requestMockTranslation(landmarks) {
    if (mockTranslationTimeout) return;
    mockTranslationTimeout = setTimeout(function () {
      mockTranslationTimeout = null;
      var word = MOCK_WORDS[mockWordIndex % MOCK_WORDS.length];
      mockWordIndex += 1;
      appendTranslation(word);
      addToHistory(word);
    }, 800);
  }

  function appendTranslation(text) {
    const current = translationDisplay.textContent.trim();
    translationDisplay.textContent = current ? current + ' ' + text : text;
  }

  function addToHistory(text) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const time = new Date().toLocaleTimeString();
    item.innerHTML = '<div class="history-text">' + escapeHtml(text) + '</div><div class="history-time">' + time + '</div>';
    historyList.insertBefore(item, historyList.firstChild);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function downloadHistory() {
    var items = historyList.querySelectorAll('.history-item');
    var lines = ['AI Sign Language Translator - Conversation History', 'Saved: ' + new Date().toLocaleString(), ''];
    for (var i = items.length - 1; i >= 0; i--) {
      var textEl = items[i].querySelector('.history-text');
      var timeEl = items[i].querySelector('.history-time');
      var text = textEl ? textEl.textContent.trim() : '';
      var time = timeEl ? timeEl.textContent.trim() : '';
      if (text) lines.push('[' + time + '] ' + text);
    }
    if (lines.length <= 3) lines.push('(No history yet)');
    var blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sign-translator-history-' + new Date().toISOString().slice(0, 10) + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ========== Detection loop ========== */
  async function startDetection() {
    if (!video.srcObject) {
      setStatus('Start camera first');
      return;
    }
    var hp = await initHands();
    if (!hp) {
      setStatus('Hand detection not available');
      return;
    }
    await initFace();
    detectionActive = true;
    detectionPaused = false;
    setStatus('Detecting hand & face...', 'detecting');
    document.getElementById('btn-start-detection').disabled = true;
    document.getElementById('btn-pause').disabled = false;
    runDetectionLoop();
  }

  function runDetectionLoop() {
    var handDetector = useLegacyHands ? handsLegacy : hands;
    if (!detectionActive || !video.videoWidth || !handDetector) return;
    if (useLegacyHands && handsLegacy) {
      faceLandmarksList = [];
      handsLegacy.send({ image: video }).then(function () {
        requestAnimationFrame(runDetectionLoop);
      }).catch(function () { requestAnimationFrame(runDetectionLoop); });
      return;
    }
    if (!hands) {
      requestAnimationFrame(runDetectionLoop);
      return;
    }
    var timestampMs = video.currentTime * 1000;
    if (timestampMs < 0) timestampMs = performance.now();
    faceLandmarksList = [];
    if (faceLandmarker) {
      try {
        var faceResult = faceLandmarker.detectForVideo(video, timestampMs);
        if (faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length) {
          faceLandmarksList = faceResult.faceLandmarks;
        }
      } catch (err) {}
    }
    try {
      var result = hands.detectForVideo(video, timestampMs);
      if (result && result.landmarks && result.handedness) {
        onHandResults(result.landmarks, result.handedness);
      } else {
        onHandResults([], []);
      }
    } catch (e) {
      onHandResults([], []);
    }
    requestAnimationFrame(runDetectionLoop);
  }

  function pauseDetection() {
    detectionPaused = true;
    setStatus('Paused');
    document.getElementById('btn-pause').textContent = 'Resume';
  }

  function resumeDetection() {
    detectionPaused = false;
    setStatus('Detecting hand...', 'detecting');
    document.getElementById('btn-pause').textContent = 'Pause';
  }

  /* ========== Sign Learning / Guide ========== */
  var ASL_DESCRIPTIONS = {
    A: 'Fist with thumb to the side (A).', B: 'Flat hand, fingers together, thumb in (B).', C: 'Curved hand like C shape.',
    D: 'Point index up, others in fist.', E: 'Fist with thumb in front of fingers.', F: 'OK sign: thumb and index circle, others up.',
    G: 'Index pointing to side (G).', H: 'Index and middle finger side by side.', I: 'Pinky up, others in fist.',
    J: 'Pinky traces J in air.', K: 'Index and middle in V, thumb between.', L: 'Index and thumb form L.',
    M: 'Three fingers down on thumb.', N: 'Two fingers on thumb.', O: 'Fingers curve into O.',
    P: 'K shape rotated (P).', Q: 'Index and thumb down (Q).', R: 'Index and middle cross (R).',
    S: 'Fist with thumb across (S).', T: 'Thumb between index and middle (T).', U: 'Index and middle together up (U).',
    V: 'Index and middle in V (V).', W: 'Three fingers up (W).', X: 'Index bent (X).', Y: 'Thumb and pinky out (Y).',
    Z: 'Index traces Z in air (Z).',
    '0': 'Closed fist, thumb over fingers (zero).', '1': 'Index finger up (one).', '2': 'Index and middle up (two).',
    '3': 'Thumb, index, middle up (three).', '4': 'Four fingers up, thumb in (four).', '5': 'All five fingers spread (five).',
    '6': 'Thumb and pinky touch (six).', '7': 'Thumb and index touch, middle up (seven).', '8': 'Thumb and index form circle, others up (eight).',
    '9': 'Index bent, others up (nine).',
    'Hello': 'Hand to forehead, move outward (wave/salute).', 'Good Bye': 'Open hand, wave side to side.',
    'Yes': 'Fist nodding up and down.', 'No': 'Index and middle tap together.',
    'Thanks': 'Touch lips then move hand forward.', 'You\'re Welcome': 'Hand from chest, move outward in arc.',
    'Please': 'Flat hand on chest, circular motion.', 'Sorry': 'Fist rubbing chest in circle.'
  };
  var ISL_DESCRIPTIONS = {
    A: 'ISL: Two fists, thumbs up, tips touching (A).', B: 'ISL: Both hands form circles, fingertips touching (B).',
    C: 'ISL: Hand forms C shape.', D: 'ISL: One hand circle, other index points (D).', E: 'ISL: Fingers intertwined (E).',
    F: 'ISL: Index and middle crossed, other palm up (F).', G: 'ISL: Thumb and index C, other fist (G).',
    H: 'ISL: Fingers interlaced (H).', I: 'ISL: Pinky up (I).', J: 'ISL: Index traces J (J).', K: 'ISL: Index and middle V, thumb between (K).',
    L: 'ISL: Thumb and index L (L).', M: 'ISL: One hand flat, other fist (M).', N: 'ISL: Index and middle flat, other fist (N).',
    O: 'ISL: Fingers form O (O).', P: 'ISL: Index and middle down, thumb touch (P).', Q: 'ISL: Both thumb-index circles touch (Q).',
    R: 'ISL: One palm forward, other index to palm (R).', S: 'ISL: Tight fist, thumb over (S).', T: 'ISL: Index out, thumb under (T).',
    U: 'ISL: Index and middle up (U).', V: 'ISL: Index and middle V (V).', W: 'ISL: Fingers interlaced (W).',
    X: 'ISL: Index fingers crossed (X).', Y: 'ISL: Thumb and pinky out (Y).', Z: 'ISL: Index traces Z (Z).',
    '0': 'ISL: Closed fist (zero).', '1': 'ISL: Index up (one).', '2': 'ISL: Index and middle V (two).', '3': 'ISL: Three fingers up (three).',
    '4': 'ISL: Four fingers up (four).', '5': 'ISL: All five spread (five).', '6': 'ISL: Thumb and pinky touch (six).',
    '7': 'ISL: Thumb and index touch (seven).', '8': 'ISL: Thumb, index, middle up (eight).', '9': 'ISL: Thumb and index curve (nine).',
    'Hello': 'ISL: Hand to forehead, move out (hello).', 'Good Bye': 'ISL: Hand wave (goodbye).', 'Yes': 'ISL: Fist nod (yes).',
    'No': 'ISL: Index and middle tap (no).', 'Thanks': 'ISL: Touch chin, move forward (thanks).',
    'You\'re Welcome': 'ISL: Hand from chest out (welcome).', 'Please': 'ISL: Hand on chest, circle (please).',
    'Sorry': 'ISL: Fist on chest, circle (sorry).'
  };

  function getSignDescriptions() {
    var mode = document.getElementById('lang-select');
    return (mode && mode.value === 'ISL') ? ISL_DESCRIPTIONS : ASL_DESCRIPTIONS;
  }


  function getGuideImagePathForSign(mode, signId, label) {
    var prefix = (mode === 'ISL') ? 'isl' : 'asl';
    var key;
    if (label.length === 1 && label >= 'A' && label <= 'Z') {
      key = label.toLowerCase();
    } else if (/^[0-9]$/.test(label) || label === 'Z') {
      key = label === 'Z' ? 'z' : label;
    } else {
      key = signId;
    }
    return 'assets/images/' + prefix + '-' + key + '.png';
  }

  function renderSignDemoIn(elViewer, elDesc, signId, label) {
    if (!elViewer) return;
    elViewer.classList.add('sign-guide-fade-out');
    var doUpdate = function () {
      var modeEl = document.getElementById('lang-select');
      var mode = (modeEl && modeEl.value === 'ISL') ? 'ISL' : 'ASL';
      var imgPath = getGuideImagePathForSign(mode, signId, label);
      var filename = imgPath.split('/').pop();
      elViewer.innerHTML = '';
      elViewer.setAttribute('data-sign', (label.length === 1 ? label : signId));
      var img = document.createElement('img');
      img.src = imgPath;
      img.alt = mode + ' sign: ' + label;
      img.className = 'sign-guide-photo';
      img.onerror = function () {
        this.style.display = 'none';
        var fallback = document.createElement('p');
        fallback.className = 'sign-guide-fallback';
        fallback.textContent = 'Photo not found. Add ' + filename + ' to the assets/images folder.';
        elViewer.appendChild(fallback);
      };
      elViewer.appendChild(img);
      elViewer.classList.remove('sign-guide-fade-out');
      if (elDesc) elDesc.textContent = getSignDescriptions()[label] || '';
    };
    if (elViewer.classList.contains('sign-guide-fade-out')) {
      setTimeout(doUpdate, 150);
    } else {
      doUpdate();
    }
  }

  function renderSignDemo(signId, label) {
    var modeEl = document.getElementById('lang-select');
    var mode = (modeEl && modeEl.value === 'ISL') ? 'ISL' : 'ASL';
    var imgPath = getGuideImagePathForSign(mode, signId, label);
    var filename = imgPath.split('/').pop();
    signDemoViewer.innerHTML = '';
    var img = document.createElement('img');
    img.src = imgPath;
    img.alt = 'Sign: ' + label;
    img.className = 'sign-guide-photo';
    img.onerror = function () {
      this.style.display = 'none';
      var fallback = document.createElement('p');
      fallback.className = 'sign-guide-fallback';
      fallback.textContent = 'Photo not found. Add ' + filename + ' to assets/images folder.';
      signDemoViewer.appendChild(fallback);
    };
    signDemoViewer.appendChild(img);
    signDescription.textContent = getSignDescriptions()[label] || '';
  }

  var lastSelectedSignId = null;
  var lastSelectedLabel = null;

  function showSignInGuideCard(signId, label) {
    lastSelectedSignId = signId;
    lastSelectedLabel = label;
    var placeholder = document.getElementById('sign-guide-placeholder');
    var demoBlock = document.getElementById('sign-guide-demo');
    var demoLabel = document.getElementById('sign-guide-demo-label');
    var demoViewer = document.getElementById('sign-guide-demo-viewer');
    var demoDesc = document.getElementById('sign-guide-demo-desc');
    if (!placeholder || !demoBlock || !demoViewer) return;
    placeholder.hidden = true;
    demoBlock.hidden = false;
    demoBlock.classList.remove('hidden');
    if (demoLabel) demoLabel.textContent = label;
    renderSignDemoIn(demoViewer, demoDesc, signId, label);
  }

  function selectSign(signId, label) {
    showSignInGuideCard(signId, label);
  }

  function openSignModal(signId, label) {
    modalTitle.textContent = 'Sign: ' + label;
    var demoLabelEl = document.getElementById('sign-demo-label');
    if (demoLabelEl) demoLabelEl.textContent = label;
    renderSignDemo(signId, label);
    signModal.setAttribute('aria-hidden', 'false');
  }

  function closeSignModal() {
    signModal.setAttribute('aria-hidden', 'true');
  }

  /* ========== Run when DOM is ready ========== */
  function init() {
    video = document.getElementById('webcam');
    canvas = document.getElementById('landmarks-canvas');
    ctx = canvas ? canvas.getContext('2d') : null;
    cameraStatus = document.getElementById('camera-status');
    translationDisplay = document.getElementById('translation-display');
    historyList = document.getElementById('history-list');
    alphabetCards = document.getElementById('alphabet-cards');
    numbersCards = document.getElementById('numbers-cards');
    wordsCards = document.getElementById('words-cards');
    signModal = document.getElementById('sign-modal');
    modalTitle = document.getElementById('modal-title');
    signDemoViewer = document.getElementById('sign-demo-viewer');
    signDescription = document.getElementById('sign-description');
    modalClose = document.getElementById('modal-close');
    if (!video || !canvas || !cameraStatus) return;
    video.addEventListener('loadedmetadata', resizeCanvas);
    document.getElementById('dark-mode-toggle').addEventListener('click', toggleTheme);
    var toggleDark = document.getElementById('toggle-dark-mode');
    if (toggleDark) toggleDark.addEventListener('change', toggleTheme);
    document.getElementById('btn-start-detection').addEventListener('click', startDetection);
    document.getElementById('btn-pause').addEventListener('click', function () {
      if (detectionPaused) resumeDetection();
      else pauseDetection();
    });
    document.getElementById('btn-clear').addEventListener('click', function () { translationDisplay.textContent = ''; });
    document.getElementById('btn-copy').addEventListener('click', function () {
      var text = translationDisplay.textContent.trim();
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () {
        var btn = document.getElementById('btn-copy');
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = orig; }, 1500);
      });
    });
    document.getElementById('btn-tts').addEventListener('click', function () {
      var text = translationDisplay.textContent.trim();
      if (!text) return;
      if ('speechSynthesis' in window) {
        var u = new SpeechSynthesisUtterance(text);
        u.rate = 0.9;
        u.pitch = 1;
        speechSynthesis.speak(u);
      }
    });
    var btnStopTts = document.getElementById('btn-stop-tts');
    if (btnStopTts) btnStopTts.addEventListener('click', function () {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    });
    document.getElementById('btn-start-camera').addEventListener('click', startCamera);
    var btnInline = document.getElementById('btn-start-camera-inline');
    if (btnInline) btnInline.addEventListener('click', startCamera);
    document.getElementById('btn-stop-camera').addEventListener('click', stopCamera);
    document.getElementById('btn-reset').addEventListener('click', function () {
      stopCamera();
      translationDisplay.textContent = '';
      historyList.innerHTML = '';
      mockWordIndex = 0;
      lastHandFrame = 0;
      if (mockTranslationTimeout) clearTimeout(mockTranslationTimeout);
      mockTranslationTimeout = null;
      setStatus('Ready — click Start Camera to begin');
    });
    document.getElementById('toggle-landmarks').addEventListener('change', function () {
      landmarksVisible = this.checked;
    });
    modalClose.addEventListener('click', closeSignModal);
    signModal.addEventListener('click', function (e) {
      if (e.target === signModal) closeSignModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && signModal.getAttribute('aria-hidden') === 'false') closeSignModal();
    });
    if (alphabetCards) {
      for (var i = 0; i < 26; i++) {
        var letter = String.fromCharCode(65 + i);
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'sign-card';
        card.textContent = letter;
        card.setAttribute('aria-label', 'Sign for ' + letter);
        card.addEventListener('click', function (l, lab) { return function () { selectSign(l, lab); }; }(letter.toLowerCase(), letter));
        alphabetCards.appendChild(card);
      }
    }
    var numbersList = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    if (numbersCards) {
      numbersList.forEach(function (num) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'sign-card';
        card.textContent = num;
        card.setAttribute('aria-label', 'Sign for ' + num);
        card.addEventListener('click', function (n) { return function () { selectSign(n, n); }; }(num));
        numbersCards.appendChild(card);
      });
    }
    var commonWordsList = [
      { label: 'Hello', signId: 'hi' },
      { label: 'Good Bye', signId: 'bye' },
      { label: 'Yes', signId: 'yes' },
      { label: 'No', signId: 'no' },
      { label: 'Thanks', signId: 'thank-you' },
      { label: 'You\'re Welcome', signId: 'welcome' },
      { label: 'Please', signId: 'please' },
      { label: 'Sorry', signId: 'sorry' }
    ];
    if (wordsCards) {
      commonWordsList.forEach(function (item) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'sign-card word';
        card.textContent = item.label;
        card.setAttribute('aria-label', 'Sign for ' + item.label);
        card.addEventListener('click', function (sid, w) { return function () { selectSign(sid, w); }; }(item.signId, item.label));
        wordsCards.appendChild(card);
      });
    }
    var showEnglish = document.getElementById('show-english-letters');
    var fixedWidth = document.getElementById('fixed-width-signs');
    var fontSizeSelect = document.getElementById('guide-font-size');
    var cardInner = document.getElementById('sign-guide-card-inner');
    var cardsRows = document.querySelectorAll('.sign-cards-row');
    if (showEnglish) showEnglish.addEventListener('change', function () {
      cardInner.classList.toggle('show-english', this.checked);
    });
    if (fixedWidth && cardsRows.length) fixedWidth.addEventListener('change', function () {
      var checked = this.checked;
      cardsRows.forEach(function (row) { row.classList.toggle('fixed-width', checked); });
    });
    if (fontSizeSelect && cardInner) fontSizeSelect.addEventListener('change', function () {
      cardInner.classList.remove('font-size-80', 'font-size-90', 'font-size-100', 'font-size-110', 'font-size-120');
      cardInner.classList.add('font-size-' + this.value);
    });
    if (cardInner) cardInner.classList.add('show-english', 'font-size-110');
    document.getElementById('lang-select').addEventListener('change', function () {
      var mode = this.value === 'ISL' ? 'ISL' : 'ASL';
      var titleEl = document.getElementById('sign-guide-title');
      var modeDesc = document.getElementById('sign-guide-mode-desc');
      if (titleEl) titleEl.textContent = 'Sign Language Guide (' + mode + ')';
      if (modeDesc) modeDesc.textContent = mode + ' mode. Click a letter, number, or word below to see the sign.';
      if (lastSelectedSignId != null && lastSelectedLabel != null) {
        var demoViewer = document.getElementById('sign-guide-demo-viewer');
        var demoDesc = document.getElementById('sign-guide-demo-desc');
        if (demoViewer) renderSignDemoIn(demoViewer, demoDesc, lastSelectedSignId, lastSelectedLabel);
      }
    });

    var btnDownloadHistory = document.getElementById('btn-download-history');
    if (btnDownloadHistory) btnDownloadHistory.addEventListener('click', downloadHistory);
    initTheme();
    var langSelect = document.getElementById('lang-select');
    var signGuideTitle = document.getElementById('sign-guide-title');
    var signGuideModeDesc = document.getElementById('sign-guide-mode-desc');
    if (langSelect && signGuideTitle) {
      var m = langSelect.value === 'ISL' ? 'ISL' : 'ASL';
      signGuideTitle.textContent = 'Sign Language Guide (' + m + ')';
      if (signGuideModeDesc) signGuideModeDesc.textContent = m + ' mode. Click a letter, number, or word below to see the sign.';
    }

    var appSection = document.getElementById('app-section');
    function scrollToApp() {
      if (appSection) appSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    var btnGetStarted = document.getElementById('btn-get-started');
    var btnGetStarted2 = document.getElementById('btn-get-started-2');
    if (btnGetStarted) btnGetStarted.addEventListener('click', function (e) { e.preventDefault(); scrollToApp(); });
    if (btnGetStarted2) btnGetStarted2.addEventListener('click', function (e) { e.preventDefault(); scrollToApp(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      try { init(); } catch (e) {
        console.error('App error:', e);
        var st = document.getElementById('camera-status');
        if (st) st.textContent = 'Error: ' + (e.message || 'Load error');
      }
    });
  } else {
    try { init(); } catch (e) {
      console.error('App error:', e);
      var st = document.getElementById('camera-status');
      if (st) st.textContent = 'Error: ' + (e.message || 'Load error');
    }
  }
})();
