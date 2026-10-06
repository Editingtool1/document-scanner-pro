const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const sourceCanvas = $("sourceCanvas");
const previewCanvas = $("previewCanvas");
const a4Canvas = $("a4Canvas");

const sourceCtx = sourceCanvas.getContext("2d");
const previewCtx = previewCanvas.getContext("2d");
const a4Ctx = a4Canvas.getContext("2d");

let sourceImage = null;
let sourceFileName = "";
let sourceDataURL = "";

let sourceDisplayScale = 1;

let corners = [];
let draggingCorner = -1;

let documents = [];
let selectedDocument = -1;

let orientation = "portrait";

let draggingDocument = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

let resizingDocument = false;
let resizingHandle = -1;
let resizeAnchor = null;
let resizeStartDistance = 0;
let resizeStartScale = 1;


/* =========================
   A4
========================= */

const A4 = {
    portrait: {
        width: 2480,
        height: 3508
    },

    landscape: {
        width: 3508,
        height: 2480
    }
};


/* =========================
   HELPERS
========================= */

function showMessage(text, type = "success") {

    const message = $("message");

    message.textContent = text;
    message.className = "message " + type;
}


function hideMessage() {

    $("message").className = "message";
    $("message").textContent = "";
}


function loadImage(dataURL) {

    return new Promise((resolve, reject) => {

        const image = new Image();

        image.onload = () => resolve(image);

        image.onerror = () => {
            reject(
                new Error("تعذر تحميل الصورة.")
            );
        };

        image.src = dataURL;
    });
}


function generateId() {

    if (
        window.crypto &&
        typeof window.crypto.randomUUID === "function"
    ) {
        return window.crypto.randomUUID();
    }

    return (
        Date.now().toString(36) +
        Math.random().toString(36).slice(2)
    );
}



/* =========================
   SMART CORNERS + REAL SIZES
========================= */

const DOCUMENT_PRESETS_MM = {
    national_id: { width: 85.60, height: 53.98, label: "البطاقة الوطنية" },
    residence_card: { width: 85.60, height: 53.98, label: "بطاقة السكن" },
    driving_license: { width: 85.60, height: 53.98, label: "إجازة السوق" },
    id1: { width: 85.60, height: 53.98, label: "بطاقة ID-1" },
    a6: { width: 105, height: 148, label: "A6" },
    a5: { width: 148, height: 210, label: "A5" }
};

function setCornerDetectionStatus(text, type = "") {
    const el = $("cornerDetectionStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (type ? " " + type : "");
}

function orderDetectedPoints(points) {
    if (!Array.isArray(points) || points.length !== 4) return null;
    const normalized = points.map((p) => ({
        x: Number(Array.isArray(p) ? p[0] : p.x),
        y: Number(Array.isArray(p) ? p[1] : p.y)
    }));
    if (normalized.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

    const sums = normalized.map(p => p.x + p.y);
    const diffs = normalized.map(p => p.y - p.x);
    return [
        normalized[sums.indexOf(Math.min(...sums))],   // top-left
        normalized[diffs.indexOf(Math.min(...diffs))], // top-right
        normalized[sums.indexOf(Math.max(...sums))],   // bottom-right
        normalized[diffs.indexOf(Math.max(...diffs))]  // bottom-left
    ];
}

function detectCornersLocally() {
    if (!sourceImage) return false;

    /*
      Browser-side fallback detector:
      it scans brightness differences from the four sides. This is intentionally
      conservative. If it cannot find a reliable rectangle, the normal inset
      rectangle remains available for manual adjustment.
    */
    const maxSide = 900;
    const scale = Math.min(1, maxSide / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
    const w = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
    const h = Math.max(1, Math.round(sourceImage.naturalHeight * scale));

    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(sourceImage, 0, 0, w, h);

    let data;
    try { data = ctx.getImageData(0, 0, w, h).data; }
    catch (_) { return false; }

    const gray = (x, y) => {
        const i = (Math.max(0, Math.min(h-1,y))*w + Math.max(0,Math.min(w-1,x))) * 4;
        return (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
    };

    // Estimate background from the image border.
    let bg = 0, count = 0;
    const step = Math.max(2, Math.round(Math.min(w,h)/150));
    for (let x=0; x<w; x+=step) { bg += gray(x,2) + gray(x,h-3); count += 2; }
    for (let y=0; y<h; y+=step) { bg += gray(2,y) + gray(w-3,y); count += 2; }
    bg /= Math.max(1,count);

    const threshold = 22;
    const rowScore = y => {
        let hits=0,total=0;
        for(let x=0;x<w;x+=step){ if(Math.abs(gray(x,y)-bg)>threshold) hits++; total++; }
        return hits/Math.max(1,total);
    };
    const colScore = x => {
        let hits=0,total=0;
        for(let y=0;y<h;y+=step){ if(Math.abs(gray(x,y)-bg)>threshold) hits++; total++; }
        return hits/Math.max(1,total);
    };

    let top=0,bottom=h-1,left=0,right=w-1;
    const needed=.16;
    while(top<h*.45 && rowScore(top)<needed) top++;
    while(bottom>h*.55 && rowScore(bottom)<needed) bottom--;
    while(left<w*.45 && colScore(left)<needed) left++;
    while(right>w*.55 && colScore(right)<needed) right--;

    if (right-left < w*.25 || bottom-top < h*.20) return false;

    const inv = 1/scale;
    corners = [
        {x:left*inv,y:top*inv},
        {x:right*inv,y:top*inv},
        {x:right*inv,y:bottom*inv},
        {x:left*inv,y:bottom*inv}
    ];
    return true;
}

async function detectDocumentCorners() {
    if (!sourceImage) {
        showMessage("أضف صورة المستند أولاً.", "error");
        return;
    }

    const button = $("detectCornersButton");
    if (button) {
        button.disabled = true;
        button.textContent = "جاري اكتشاف الزوايا...";
    }
    setCornerDetectionStatus("جاري تحليل الصورة...");

    let detected = false;

    // Prefer a server detector if the updated Flask backend exposes it.
    try {
        const response = await fetch("/api/detect-corners", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ image: sourceDataURL })
        });
        if (response.ok) {
            const data = await response.json();
            const ordered = orderDetectedPoints(data.points || data.corners);
            if (ordered) {
                corners = ordered;
                detected = true;
            }
        }
    } catch (_) {
        // Fall back to browser-side detection below.
    }

    if (!detected) detected = detectCornersLocally();

    if (!detected) {
        createInitialCorners();
        setCornerDetectionStatus("لم أتمكن من تحديد الحدود بدقة؛ عدّل النقاط 1–4 يدوياً.", "warning");
    } else {
        setCornerDetectionStatus("تم اكتشاف الزوايا تلقائياً. يمكنك تعديل النقاط يدوياً عند الحاجة.", "success");
    }

    drawSource();
    if (button) {
        button.disabled = false;
        button.textContent = "✨ اكتشاف الزوايا تلقائياً";
    }
}

function mmToA4Pixels(mm) {
    // A4 constants are 300 DPI (2480 × 3508).
    return Number(mm) * 300 / 25.4;
}

function applyPhysicalSizeToSelected() {
    const doc = getSelectedDocument();
    if (!doc) return;

    const widthEl = $("documentWidthMm");
    const heightEl = $("documentHeightMm");
    if (!widthEl || !heightEl) return;

    let widthMm = Number(widthEl.value);
    let heightMm = Number(heightEl.value);
    if (!(widthMm > 0) || !(heightMm > 0)) return;

    // If document orientation differs, rotate the physical dimensions automatically.
    const imageLandscape = doc.naturalWidth >= doc.naturalHeight;
    const sizeLandscape = widthMm >= heightMm;
    if (imageLandscape !== sizeLandscape) [widthMm, heightMm] = [heightMm, widthMm];

    const scaleX = mmToA4Pixels(widthMm) / doc.naturalWidth;
    const scaleY = mmToA4Pixels(heightMm) / doc.naturalHeight;

    // Keep the image aspect ratio. Use the dimension with the smaller distortion.
    doc.scale = Math.max(0.02, Math.min(10, Math.min(scaleX, scaleY)));
    doc.physicalWidthMm = widthMm;
    doc.physicalHeightMm = heightMm;
    doc.sizeLocked = Boolean($("lockDocumentSize") && $("lockDocumentSize").checked);

    updateDocumentControls();
    drawA4();
}

function syncPhysicalSizeControls() {
    const doc = getSelectedDocument();
    const info = $("physicalSizeInfo");
    if (!doc) {
        if (info) info.textContent = "حدد مستنداً من A4 أولاً.";
        return;
    }
    if ($("lockDocumentSize")) $("lockDocumentSize").checked = Boolean(doc.sizeLocked);
    if (doc.physicalWidthMm && $("documentWidthMm")) $("documentWidthMm").value = Number(doc.physicalWidthMm).toFixed(1);
    if (doc.physicalHeightMm && $("documentHeightMm")) $("documentHeightMm").value = Number(doc.physicalHeightMm).toFixed(1);
    if (info) {
        const widthPx = doc.naturalWidth * doc.scale;
        const heightPx = doc.naturalHeight * doc.scale;
        info.textContent = "الحجم على A4 تقريباً: " +
            (widthPx * 25.4 / 300).toFixed(1) + " × " +
            (heightPx * 25.4 / 300).toFixed(1) + " mm";
    }
}

/* =========================
   IMAGE UPLOAD
========================= */

fileInput.addEventListener(
    "change",
    function (event) {

        const file = event.target.files[0];

        if (!file) {
            return;
        }

        if (!file.type.startsWith("image/")) {

            showMessage(
                "يرجى اختيار صورة صحيحة.",
                "error"
            );

            return;
        }

        sourceFileName = file.name;

        const reader = new FileReader();

        reader.onload = async function (readerEvent) {

            try {

                sourceDataURL =
                    readerEvent.target.result;

                sourceImage =
                    await loadImage(
                        sourceDataURL
                    );

                prepareSourceCanvas();

                createInitialCorners();

                drawSource();

                // محاولة تلقائية مباشرة بعد رفع الصورة.
                setTimeout(() => detectDocumentCorners(), 80);

                $("emptySource").style.display =
                    "none";

                sourceCanvas.style.display =
                    "block";

                $("fileStatus").textContent =
                    "جاهز: " + sourceFileName;

                hideMessage();

            } catch (error) {

                showMessage(
                    error.message,
                    "error"
                );
            }
        };

        reader.readAsDataURL(file);
    }
);


/* =========================
   SOURCE CANVAS
========================= */

function prepareSourceCanvas() {

    if (!sourceImage) {
        return;
    }

    const container =
        sourceCanvas.parentElement;

    const maximumWidth =
        Math.min(
            900,
            Math.max(
                300,
                container.clientWidth - 20
            )
        );

    const maximumHeight = 650;

    sourceDisplayScale =
        Math.min(
            maximumWidth /
                sourceImage.naturalWidth,

            maximumHeight /
                sourceImage.naturalHeight,

            1
        );

    sourceCanvas.width =
        Math.round(
            sourceImage.naturalWidth *
            sourceDisplayScale
        );

    sourceCanvas.height =
        Math.round(
            sourceImage.naturalHeight *
            sourceDisplayScale
        );
}


function createInitialCorners() {

    if (!sourceImage) {
        return;
    }

    const width =
        sourceImage.naturalWidth;

    const height =
        sourceImage.naturalHeight;

    corners = [

        {
            x: width * 0.08,
            y: height * 0.08
        },

        {
            x: width * 0.92,
            y: height * 0.08
        },

        {
            x: width * 0.92,
            y: height * 0.92
        },

        {
            x: width * 0.08,
            y: height * 0.92
        }

    ];
}


function drawSource() {

    if (!sourceImage) {
        return;
    }

    sourceCtx.clearRect(
        0,
        0,
        sourceCanvas.width,
        sourceCanvas.height
    );

    sourceCtx.drawImage(
        sourceImage,
        0,
        0,
        sourceCanvas.width,
        sourceCanvas.height
    );


    /* تظليل خارج المستند */

    const displayPoints =
        corners.map((point) => ({
            x:
                point.x *
                sourceDisplayScale,

            y:
                point.y *
                sourceDisplayScale
        }));


    sourceCtx.save();

    sourceCtx.fillStyle =
        "rgba(0, 0, 0, 0.32)";

    sourceCtx.beginPath();

    sourceCtx.rect(
        0,
        0,
        sourceCanvas.width,
        sourceCanvas.height
    );

    sourceCtx.moveTo(
        displayPoints[0].x,
        displayPoints[0].y
    );

    displayPoints.forEach(
        (point) => {

            sourceCtx.lineTo(
                point.x,
                point.y
            );
        }
    );

    sourceCtx.closePath();

    sourceCtx.fill("evenodd");

    sourceCtx.restore();


    /* خطوط 1-2-3-4 */

    sourceCtx.save();

    sourceCtx.beginPath();

    sourceCtx.moveTo(
        displayPoints[0].x,
        displayPoints[0].y
    );

    for (
        let index = 1;
        index < displayPoints.length;
        index++
    ) {

        sourceCtx.lineTo(
            displayPoints[index].x,
            displayPoints[index].y
        );
    }

    sourceCtx.closePath();

    sourceCtx.strokeStyle =
        "#24e58b";

    sourceCtx.lineWidth = 3;

    sourceCtx.shadowColor =
        "rgba(0,0,0,0.5)";

    sourceCtx.shadowBlur = 4;

    sourceCtx.stroke();

    sourceCtx.restore();


    /* النقاط */

    displayPoints.forEach(
        (point, index) => {

            sourceCtx.save();

            sourceCtx.beginPath();

            sourceCtx.arc(
                point.x,
                point.y,
                17,
                0,
                Math.PI * 2
            );

            sourceCtx.fillStyle =
                "#7b1734";

            sourceCtx.fill();

            sourceCtx.lineWidth = 3;

            sourceCtx.strokeStyle =
                "#ffffff";

            sourceCtx.stroke();


            sourceCtx.fillStyle =
                "#ffffff";

            sourceCtx.font =
                "bold 14px Arial";

            sourceCtx.textAlign =
                "center";

            sourceCtx.textBaseline =
                "middle";

            sourceCtx.fillText(
                String(index + 1),
                point.x,
                point.y
            );

            sourceCtx.restore();
        }
    );
}


/* =========================
   SOURCE POINTER
========================= */

function getCanvasPointer(
    canvas,
    event
) {

    const rectangle =
        canvas.getBoundingClientRect();

    return {

        x:
            (event.clientX -
                rectangle.left) *
            (
                canvas.width /
                rectangle.width
            ),

        y:
            (event.clientY -
                rectangle.top) *
            (
                canvas.height /
                rectangle.height
            )
    };
}


sourceCanvas.addEventListener(
    "pointerdown",
    function (event) {

        if (!sourceImage) {
            return;
        }

        const pointer =
            getCanvasPointer(
                sourceCanvas,
                event
            );

        let closestIndex = -1;
        let closestDistance = Infinity;


        corners.forEach(
            (corner, index) => {

                const x =
                    corner.x *
                    sourceDisplayScale;

                const y =
                    corner.y *
                    sourceDisplayScale;

                const distance =
                    Math.hypot(
                        pointer.x - x,
                        pointer.y - y
                    );

                if (
                    distance <
                    closestDistance
                ) {

                    closestDistance =
                        distance;

                    closestIndex =
                        index;
                }
            }
        );


        if (closestDistance <= 45) {

            draggingCorner =
                closestIndex;

            sourceCanvas.setPointerCapture(
                event.pointerId
            );
        }
    }
);


sourceCanvas.addEventListener(
    "pointermove",
    function (event) {

        if (
            draggingCorner < 0 ||
            !sourceImage
        ) {
            return;
        }

        const pointer =
            getCanvasPointer(
                sourceCanvas,
                event
            );

        const originalX =
            pointer.x /
            sourceDisplayScale;

        const originalY =
            pointer.y /
            sourceDisplayScale;


        corners[draggingCorner] = {

            x:
                Math.max(
                    0,
                    Math.min(
                        sourceImage.naturalWidth,
                        originalX
                    )
                ),

            y:
                Math.max(
                    0,
                    Math.min(
                        sourceImage.naturalHeight,
                        originalY
                    )
                )
        };

        drawSource();
    }
);


function finishCornerDrag() {
    draggingCorner = -1;
}


sourceCanvas.addEventListener(
    "pointerup",
    finishCornerDrag
);

sourceCanvas.addEventListener(
    "pointercancel",
    finishCornerDrag
);


/* =========================
   SLIDER VALUES
========================= */

function updateProcessingValues() {

    $("brightnessValue").textContent =
        Math.round(
            Number(
                $("brightness").value
            ) * 100
        ) + "%";


    $("contrastValue").textContent =
        Math.round(
            Number(
                $("contrast").value
            ) * 100
        ) + "%";


    $("sharpnessValue").textContent =
        Math.round(
            Number(
                $("sharpness").value
            ) * 100
        ) + "%";
}


[
    "brightness",
    "contrast",
    "sharpness"
].forEach((id) => {

    $(id).addEventListener(
        "input",
        updateProcessingValues
    );
});


updateProcessingValues();


/* =========================
   CORRECT DOCUMENT
========================= */

$("correctButton").addEventListener(
    "click",
    async function () {

        if (
            !sourceImage ||
            corners.length !== 4
        ) {

            showMessage(
                "أضف صورة المستند أولاً.",
                "error"
            );

            return;
        }

        const button =
            $("correctButton");

        button.disabled = true;

        button.textContent =
            "جاري التصحيح...";

        hideMessage();


        try {

            const response =
                await fetch(
                    "/api/process",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                image:
                                    sourceDataURL,

                                points:
                                    corners,

                                mode:
                                    $("mode").value,

                                brightness:
                                    $("mode").value === "original"
                                        ? 1
                                        : Number($("brightness").value),

                                contrast:
                                    $("mode").value === "original"
                                        ? 1
                                        : Number($("contrast").value),

                                sharpness:
                                    $("mode").value === "original"
                                        ? 1
                                        : Number($("sharpness").value)
                            })
                    }
                );


            const data =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    data.error ||
                    "فشل تصحيح المستند."
                );
            }


            const correctedImage =
                await loadImage(
                    data.image
                );


            previewCanvas.width =
                correctedImage.naturalWidth;

            previewCanvas.height =
                correctedImage.naturalHeight;


            previewCtx.clearRect(
                0,
                0,
                previewCanvas.width,
                previewCanvas.height
            );


            previewCtx.drawImage(
                correctedImage,
                0,
                0
            );


            $("emptyPreview").style.display =
                "none";

            previewCanvas.style.display =
                "block";


            if ($("autoAddA4").checked) {

                addDocumentToA4(
                    data.image,
                    data.width,
                    data.height
                );
            }


            showMessage(
                "تم تصحيح المستند بنجاح.",
                "success"
            );

        } catch (error) {

            showMessage(
                error.message,
                "error"
            );

        } finally {

            button.disabled = false;

            button.textContent =
                "تصحيح المستند";
        }
    }
);


/* =========================
   ADD TO A4
========================= */

function addDocumentToA4(
    imageData,
    width,
    height
) {

    const page =
        A4[orientation];

    /*
      الحجم الابتدائي:
      لا نجعل المستند أكبر من 65%
      من عرض A4.
    */

    let initialScale = 1;

    const maximumWidth =
        page.width * 0.65;

    if (width > maximumWidth) {

        initialScale =
            maximumWidth / width;
    }


    const displayedWidth =
        width * initialScale;

    const displayedHeight =
        height * initialScale;


    const documentObject = {

        id: generateId(),

        name:
            sourceFileName ||
            "مستند",

        image:
            imageData,

        naturalWidth:
            width,

        naturalHeight:
            height,

        x:
            Math.max(
                0,
                (page.width -
                    displayedWidth) / 2
            ),

        y:
            Math.max(
                0,
                (page.height -
                    displayedHeight) / 2
            ),

        scale:
            initialScale,

        rotation:
            0,

        physicalWidthMm: null,
        physicalHeightMm: null,
        sizeLocked: false
    };


    documents.push(
        documentObject
    );


    selectedDocument =
        documents.length - 1;


    renderDocumentsList();

    updateDocumentControls();

    drawA4();
}


/* =========================
   DOCUMENT LIST
========================= */

function renderDocumentsList() {

    const list =
        $("documentsList");

    list.innerHTML = "";


    $("documentsCount").textContent =
        documents.length;


    if (documents.length === 0) {

        list.innerHTML = `
            <div class="no-documents">
                لا توجد مستندات في A4
            </div>
        `;

        return;
    }


    documents.forEach(
        (documentObject, index) => {

            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "document-item" +
                (
                    index ===
                    selectedDocument
                        ? " active"
                        : ""
                );


            const thumbnail =
                document.createElement(
                    "img"
                );

            thumbnail.className =
                "document-thumb";

            thumbnail.src =
                documentObject.image;


            const information =
                document.createElement(
                    "div"
                );

            information.className =
                "document-info";


            const name =
                document.createElement(
                    "span"
                );

            name.className =
                "document-name";

            name.textContent =
                documentObject.name;


            const number =
                document.createElement(
                    "span"
                );

            number.className =
                "document-number";

            number.textContent =
                "مستند " +
                (index + 1);


            information.appendChild(
                name
            );

            information.appendChild(
                number
            );


            item.appendChild(
                thumbnail
            );

            item.appendChild(
                information
            );


            item.addEventListener(
                "click",
                function () {

                    selectedDocument =
                        index;

                    renderDocumentsList();

                    updateDocumentControls();

                    drawA4();
                }
            );


            list.appendChild(
                item
            );
        }
    );
}


/* =========================
   DOCUMENT CONTROLS
========================= */

function getSelectedDocument() {

    if (
        selectedDocument < 0 ||
        selectedDocument >=
            documents.length
    ) {

        return null;
    }

    return documents[
        selectedDocument
    ];
}


function updateDocumentControls() {

    const documentObject =
        getSelectedDocument();

    if (!documentObject) {

        $("positionX").value = 0;
        $("positionY").value = 0;

        $("documentScale").value =
            100;

        $("documentRotation").value =
            0;

        $("documentScaleValue").textContent =
            "100%";

        $("documentRotationValue").textContent =
            "0°";

        return;
    }


    $("positionX").value =
        Math.round(
            documentObject.x
        );


    $("positionY").value =
        Math.round(
            documentObject.y
        );


    $("documentScale").value =
        Math.round(
            documentObject.scale *
            100
        );


    $("documentRotation").value =
        Math.round(
            documentObject.rotation
        );


    $("documentScaleValue").textContent =
        Math.round(
            documentObject.scale *
            100
        ) + "%";


    $("documentRotationValue").textContent =
        Math.round(
            documentObject.rotation
        ) + "°";

    syncPhysicalSizeControls();
}


$("positionX").addEventListener(
    "input",
    function () {

        const documentObject =
            getSelectedDocument();

        if (!documentObject) {
            return;
        }

        documentObject.x =
            Number(
                $("positionX").value
            ) || 0;

        drawA4();
    }
);


$("positionY").addEventListener(
    "input",
    function () {

        const documentObject =
            getSelectedDocument();

        if (!documentObject) {
            return;
        }

        documentObject.y =
            Number(
                $("positionY").value
            ) || 0;

        drawA4();
    }
);


$("documentScale").addEventListener(
    "input",
    function () {

        const documentObject =
            getSelectedDocument();

        if (!documentObject) {
            return;
        }

        if (documentObject.sizeLocked) {
            updateDocumentControls();
            showMessage("المقاس الحقيقي مقفول. ألغِ القفل لتغيير الحجم يدوياً.", "error");
            return;
        }

        documentObject.scale =
            Number(
                $("documentScale").value
            ) / 100;

        documentObject.physicalWidthMm = null;
        documentObject.physicalHeightMm = null;


        $("documentScaleValue").textContent =
            $("documentScale").value +
            "%";


        drawA4();
    }
);


$("documentRotation").addEventListener(
    "input",
    function () {

        const documentObject =
            getSelectedDocument();

        if (!documentObject) {
            return;
        }

        documentObject.rotation =
            Number(
                $("documentRotation").value
            );


        $("documentRotationValue").textContent =
            $("documentRotation").value +
            "°";


        drawA4();
    }
);


/* =========================
   ORIENTATION
========================= */

$("portraitButton").addEventListener(
    "click",
    function () {

        orientation =
            "portrait";

        $("portraitButton")
            .classList.add(
                "active"
            );

        $("landscapeButton")
            .classList.remove(
                "active"
            );

        drawA4();
    }
);


$("landscapeButton").addEventListener(
    "click",
    function () {

        orientation =
            "landscape";

        $("landscapeButton")
            .classList.add(
                "active"
            );

        $("portraitButton")
            .classList.remove(
                "active"
            );

        drawA4();
    }
);


/* =========================
   DRAW A4
========================= */

function prepareA4Canvas() {

    const page =
        A4[orientation];

    const workspace =
        a4Canvas.parentElement;

    const maximumWidth =
        Math.min(
            850,
            Math.max(
                280,
                workspace.clientWidth -
                55
            )
        );


    const scale =
        maximumWidth /
        page.width;


    a4Canvas.width =
        Math.round(
            page.width *
            scale
        );


    a4Canvas.height =
        Math.round(
            page.height *
            scale
        );


    return scale;
}


function drawA4() {

    const page =
        A4[orientation];

    const canvasScale =
        prepareA4Canvas();


    a4Ctx.clearRect(
        0,
        0,
        a4Canvas.width,
        a4Canvas.height
    );


    a4Ctx.fillStyle =
        "#ffffff";

    a4Ctx.fillRect(
        0,
        0,
        a4Canvas.width,
        a4Canvas.height
    );


    documents.forEach(
        (
            documentObject,
            index
        ) => {

            const image =
                new Image();


            image.onload =
                function () {

                    const width =
                        documentObject.naturalWidth *
                        documentObject.scale;


                    const height =
                        documentObject.naturalHeight *
                        documentObject.scale;


                    const centerX =
                        (
                            documentObject.x +
                            width / 2
                        ) *
                        canvasScale;


                    const centerY =
                        (
                            documentObject.y +
                            height / 2
                        ) *
                        canvasScale;


                    const drawWidth =
                        width *
                        canvasScale;


                    const drawHeight =
                        height *
                        canvasScale;


                    a4Ctx.save();


                    a4Ctx.translate(
                        centerX,
                        centerY
                    );


                    a4Ctx.rotate(
                        documentObject.rotation *
                        Math.PI /
                        180
                    );


                    a4Ctx.drawImage(
                        image,

                        -drawWidth / 2,
                        -drawHeight / 2,

                        drawWidth,
                        drawHeight
                    );


                    if (
                        index ===
                        selectedDocument
                    ) {

                        a4Ctx.strokeStyle =
                            "#7b1734";

                        a4Ctx.lineWidth = 3;

                        a4Ctx.setLineDash(
                            [8, 5]
                        );


                        a4Ctx.strokeRect(

                            -drawWidth / 2,
                            -drawHeight / 2,

                            drawWidth,
                            drawHeight
                        );


                        a4Ctx.setLineDash(
                            []
                        );


                        drawSelectionHandles(
                            drawWidth,
                            drawHeight
                        );
                    }


                    a4Ctx.restore();
                };


            image.src =
                documentObject.image;
        }
    );
}


function drawSelectionHandles(
    width,
    height
) {

    const handleSize = 8;

    const positions = [

        {
            x: -width / 2,
            y: -height / 2
        },

        {
            x: width / 2,
            y: -height / 2
        },

        {
            x: width / 2,
            y: height / 2
        },

        {
            x: -width / 2,
            y: height / 2
        }

    ];


    a4Ctx.fillStyle =
        "#7b1734";


    positions.forEach(
        (position) => {

            a4Ctx.fillRect(

                position.x -
                handleSize / 2,

                position.y -
                handleSize / 2,

                handleSize,
                handleSize
            );
        }
    );
}



function getDocumentHandleAtPoint(documentObject, pageX, pageY) {
    if (!documentObject || Math.abs(Number(documentObject.rotation) || 0) > 0.01) return -1;

    const w = documentObject.naturalWidth * documentObject.scale;
    const h = documentObject.naturalHeight * documentObject.scale;
    const points = [
        {x:documentObject.x, y:documentObject.y},
        {x:documentObject.x+w, y:documentObject.y},
        {x:documentObject.x+w, y:documentObject.y+h},
        {x:documentObject.x, y:documentObject.y+h}
    ];
    const hitRadius = Math.max(25, Math.min(w,h)*0.055);
    let best=-1, bestDistance=Infinity;
    points.forEach((p,i)=>{
        const d=Math.hypot(pageX-p.x,pageY-p.y);
        if(d<hitRadius && d<bestDistance){best=i;bestDistance=d;}
    });
    return best;
}

function startResizeDocument(documentObject, handleIndex, pointer) {
    if (documentObject.sizeLocked) {
        showMessage("المقاس الحقيقي مقفول. ألغِ القفل قبل السحب من الزوايا.", "error");
        return false;
    }

    const w=documentObject.naturalWidth*documentObject.scale;
    const h=documentObject.naturalHeight*documentObject.scale;
    const opposite = [
        {x:documentObject.x+w,y:documentObject.y+h},
        {x:documentObject.x,y:documentObject.y+h},
        {x:documentObject.x,y:documentObject.y},
        {x:documentObject.x+w,y:documentObject.y}
    ][handleIndex];

    resizingDocument=true;
    resizingHandle=handleIndex;
    resizeAnchor=opposite;
    resizeStartDistance=Math.max(1,Math.hypot(pointer.x-opposite.x,pointer.y-opposite.y));
    resizeStartScale=documentObject.scale;
    draggingDocument=false;
    return true;
}

function resizeSelectedDocument(pointer) {
    const doc=getSelectedDocument();
    if(!doc || !resizingDocument || !resizeAnchor) return;

    const distance=Math.max(1,Math.hypot(pointer.x-resizeAnchor.x,pointer.y-resizeAnchor.y));
    const newScale=Math.max(0.02,Math.min(10,resizeStartScale*(distance/resizeStartDistance)));

    const newW=doc.naturalWidth*newScale;
    const newH=doc.naturalHeight*newScale;

    // Keep the opposite corner fixed.
    if(resizingHandle===0){doc.x=resizeAnchor.x-newW;doc.y=resizeAnchor.y-newH;}
    if(resizingHandle===1){doc.x=resizeAnchor.x;doc.y=resizeAnchor.y-newH;}
    if(resizingHandle===2){doc.x=resizeAnchor.x;doc.y=resizeAnchor.y;}
    if(resizingHandle===3){doc.x=resizeAnchor.x-newW;doc.y=resizeAnchor.y;}

    doc.scale=newScale;
    doc.physicalWidthMm=null;
    doc.physicalHeightMm=null;
    updateDocumentControls();
    drawA4();
}

/* =========================
   SELECT DOCUMENT ON A4
========================= */

function findDocumentAtPoint(
    pageX,
    pageY
) {

    for (
        let index =
            documents.length - 1;

        index >= 0;

        index--
    ) {

        const documentObject =
            documents[index];


        const width =
            documentObject.naturalWidth *
            documentObject.scale;


        const height =
            documentObject.naturalHeight *
            documentObject.scale;


        /*
          Hit test تقريبي.
          يكفي للسحب حتى عند وجود دوران.
        */

        if (
            pageX >=
                documentObject.x &&

            pageX <=
                documentObject.x +
                width &&

            pageY >=
                documentObject.y &&

            pageY <=
                documentObject.y +
                height
        ) {

            return index;
        }
    }

    return -1;
}


function getA4Pointer(event) {

    const page =
        A4[orientation];


    const rectangle =
        a4Canvas.getBoundingClientRect();


    const canvasX =
        (
            event.clientX -
            rectangle.left
        ) *
        (
            a4Canvas.width /
            rectangle.width
        );


    const canvasY =
        (
            event.clientY -
            rectangle.top
        ) *
        (
            a4Canvas.height /
            rectangle.height
        );


    return {

        x:
            canvasX *
            (
                page.width /
                a4Canvas.width
            ),

        y:
            canvasY *
            (
                page.height /
                a4Canvas.height
            )
    };
}


a4Canvas.addEventListener(
    "pointerdown",
    function (event) {

        if (
            documents.length === 0
        ) {
            return;
        }


        const pointer =
            getA4Pointer(event);

        // مقابض الزوايا لها الأولوية على سحب المستند.
        const currentDocument = getSelectedDocument();
        const handleIndex = getDocumentHandleAtPoint(
            currentDocument,
            pointer.x,
            pointer.y
        );

        if (handleIndex >= 0) {
            if (startResizeDocument(currentDocument, handleIndex, pointer)) {
                a4Canvas.setPointerCapture(event.pointerId);
                drawA4();
            }
            return;
        }


        const foundIndex =
            findDocumentAtPoint(
                pointer.x,
                pointer.y
            );


        if (foundIndex < 0) {
            return;
        }


        selectedDocument =
            foundIndex;


        const documentObject =
            documents[
                selectedDocument
            ];


        dragOffsetX =
            pointer.x -
            documentObject.x;


        dragOffsetY =
            pointer.y -
            documentObject.y;


        draggingDocument = true;


        a4Canvas.setPointerCapture(
            event.pointerId
        );


        renderDocumentsList();

        updateDocumentControls();

        drawA4();
    }
);


a4Canvas.addEventListener(
    "pointermove",
    function (event) {

        if (resizingDocument) {
            resizeSelectedDocument(getA4Pointer(event));
            return;
        }

        if (
            !draggingDocument
        ) {
            return;
        }


        const documentObject =
            getSelectedDocument();


        if (!documentObject) {
            return;
        }


        const pointer =
            getA4Pointer(event);


        documentObject.x =
            pointer.x -
            dragOffsetX;


        documentObject.y =
            pointer.y -
            dragOffsetY;


        updateDocumentControls();

        drawA4();
    }
);


function finishDocumentDrag() {

    draggingDocument = false;
    resizingDocument = false;
    resizingHandle = -1;
    resizeAnchor = null;
}


a4Canvas.addEventListener(
    "pointerup",
    finishDocumentDrag
);

a4Canvas.addEventListener(
    "pointercancel",
    finishDocumentDrag
);


/* =========================
   QUICK POSITIONS
========================= */

document
    .querySelectorAll(
        ".position-grid button"
    )
    .forEach((button) => {

        button.addEventListener(
            "click",
            function () {

                const documentObject =
                    getSelectedDocument();


                if (!documentObject) {

                    showMessage(
                        "حدد مستنداً من A4 أولاً.",
                        "error"
                    );

                    return;
                }


                const page =
                    A4[orientation];


                const width =
                    documentObject.naturalWidth *
                    documentObject.scale;


                const height =
                    documentObject.naturalHeight *
                    documentObject.scale;


                const margin = 60;


                const position =
                    button.dataset.position;


                let x =
                    documentObject.x;

                let y =
                    documentObject.y;


                if (
                    position.endsWith(
                        "l"
                    )
                ) {

                    /*
                      لأن الصفحة RTL لكن X
                      يبدأ من يسار Canvas.
                    */

                    x = margin;
                }


                if (
                    position.endsWith(
                        "c"
                    )
                ) {

                    x =
                        (
                            page.width -
                            width
                        ) / 2;
                }


                if (
                    position.endsWith(
                        "r"
                    )
                ) {

                    x =
                        page.width -
                        width -
                        margin;
                }


                if (
                    position.startsWith(
                        "t"
                    )
                ) {

                    y = margin;
                }


                if (
                    position.startsWith(
                        "m"
                    )
                ) {

                    y =
                        (
                            page.height -
                            height
                        ) / 2;
                }


                if (
                    position.startsWith(
                        "b"
                    )
                ) {

                    y =
                        page.height -
                        height -
                        margin;
                }


                documentObject.x =
                    Math.max(
                        0,
                        x
                    );


                documentObject.y =
                    Math.max(
                        0,
                        y
                    );


                updateDocumentControls();

                drawA4();
            }
        );
    });


/* =========================
   DUPLICATE
========================= */

$("duplicateDocument").addEventListener(
    "click",
    function () {

        const documentObject =
            getSelectedDocument();


        if (!documentObject) {

            showMessage(
                "حدد مستنداً أولاً.",
                "error"
            );

            return;
        }


        const copy = {

            ...documentObject,

            id:
                generateId(),

            name:
                documentObject.name +
                " - نسخة",

            x:
                documentObject.x +
                50,

            y:
                documentObject.y +
                50
        };


        documents.push(copy);

        selectedDocument =
            documents.length - 1;


        renderDocumentsList();

        updateDocumentControls();

        drawA4();
    }
);


/* =========================
   DELETE
========================= */

$("deleteDocument").addEventListener(
    "click",
    function () {

        if (
            selectedDocument < 0
        ) {

            showMessage(
                "حدد مستنداً أولاً.",
                "error"
            );

            return;
        }


        documents.splice(
            selectedDocument,
            1
        );


        if (
            documents.length === 0
        ) {

            selectedDocument = -1;

        } else {

            selectedDocument =
                Math.min(
                    selectedDocument,
                    documents.length - 1
                );
        }


        renderDocumentsList();

        updateDocumentControls();

        drawA4();
    }
);


/* =========================
   CLEAR A4
========================= */

$("clearA4").addEventListener(
    "click",
    function () {

        if (
            documents.length === 0
        ) {
            return;
        }


        const confirmed =
            window.confirm(
                "هل تريد حذف جميع المستندات من صفحة A4؟"
            );


        if (!confirmed) {
            return;
        }


        documents = [];

        selectedDocument = -1;


        renderDocumentsList();

        updateDocumentControls();

        drawA4();


        showMessage(
            "تم تفريغ صفحة A4.",
            "success"
        );
    }
);


/* =========================
   EXPORT QUALITY
========================= */

$("exportQuality").addEventListener(
    "input",
    function () {

        $("qualityValue").textContent =
            $("exportQuality").value +
            "%";
    }
);


/* =========================
   DOWNLOAD
========================= */

$("downloadButton").addEventListener(
    "click",
    async function () {

        if (
            documents.length === 0
        ) {

            showMessage(
                "أضف مستنداً إلى A4 قبل التحميل.",
                "error"
            );

            return;
        }


        const button =
            $("downloadButton");


        button.disabled = true;

        button.textContent =
            "جاري إنشاء الملف...";


        hideMessage();


        try {

            const items =
                documents.map(
                    (documentObject) => ({
                        image:
                            documentObject.image,

                        x:
                            documentObject.x,

                        y:
                            documentObject.y,

                        scale:
                            documentObject.scale,

                        rotation:
                            documentObject.rotation
                    })
                );


            const response =
                await fetch(
                    "/api/export",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                orientation:
                                    orientation,

                                format:
                                    $("exportFormat").value,

                                quality:
                                    Number(
                                        $("exportQuality").value
                                    ),

                                items:
                                    items
                            })
                    }
                );


            if (!response.ok) {

                let errorText =
                    "فشل إنشاء الملف.";

                try {

                    const data =
                        await response.json();

                    errorText =
                        data.error ||
                        errorText;

                } catch (_) {
                    // ignore
                }


                throw new Error(
                    errorText
                );
            }


            const blob =
                await response.blob();


            const url =
                URL.createObjectURL(
                    blob
                );


            const link =
                document.createElement(
                    "a"
                );


            let extension =
                $("exportFormat").value;


            if (
                extension ===
                "jpeg"
            ) {
                extension = "jpg";
            }


            link.href = url;

            link.download =
                "documents-a4." +
                extension;


            document.body.appendChild(
                link
            );


            link.click();


            link.remove();


            setTimeout(
                function () {

                    URL.revokeObjectURL(
                        url
                    );
                },

                1000
            );


            const sizeMB =
                (
                    blob.size /
                    1024 /
                    1024
                ).toFixed(2);


            showMessage(
                "تم إنشاء الملف بنجاح — الحجم: " +
                sizeMB +
                " MB",
                "success"
            );

        } catch (error) {

            showMessage(
                error.message,
                "error"
            );

        } finally {

            button.disabled = false;

            button.textContent =
                "↓ تحميل الملف النهائي";
        }
    }
);


/* =========================
   WINDOW RESIZE
========================= */

let resizeTimer = null;


window.addEventListener(
    "resize",
    function () {

        clearTimeout(
            resizeTimer
        );


        resizeTimer =
            setTimeout(
                function () {

                    if (sourceImage) {

                        prepareSourceCanvas();

                        drawSource();
                    }


                    drawA4();

                },

                120
            );
    }
);



/* =========================
   NEW UI CONTROLS
========================= */

if ($("detectCornersButton")) {
    $("detectCornersButton").addEventListener("click", detectDocumentCorners);
}

if ($("documentPreset")) {
    $("documentPreset").addEventListener("change", function () {
        const value=this.value;
        const preset=DOCUMENT_PRESETS_MM[value];

        if (preset) {
            $("documentWidthMm").value=preset.width;
            $("documentHeightMm").value=preset.height;
            applyPhysicalSizeToSelected();
            if ($("physicalSizeInfo")) {
                $("physicalSizeInfo").textContent =
                    preset.label + ": " + preset.width + " × " + preset.height + " mm";
            }
        } else if (value === "passport") {
            // Passport booklets are not one universal physical size.
            $("documentWidthMm").value="";
            $("documentHeightMm").value="";
            if ($("physicalSizeInfo")) {
                $("physicalSizeInfo").textContent =
                    "توجد مقاسات مختلفة لجوازات السفر؛ أدخل عرض وارتفاع الجواز الفعلي بالـ mm.";
            }
        } else if (value === "custom") {
            if ($("physicalSizeInfo")) $("physicalSizeInfo").textContent =
                "أدخل العرض والارتفاع الحقيقيين بالـ mm.";
        }
    });
}

["documentWidthMm","documentHeightMm"].forEach(id=>{
    if ($(id)) $(id).addEventListener("change", applyPhysicalSizeToSelected);
});

if ($("lockDocumentSize")) {
    $("lockDocumentSize").addEventListener("change", function () {
        const doc=getSelectedDocument();
        if(!doc) return;
        if(this.checked) {
            applyPhysicalSizeToSelected();
            doc.sizeLocked=true;
        } else {
            doc.sizeLocked=false;
        }
        syncPhysicalSizeControls();
        drawA4();
    });
}

if ($("mode")) {
    $("mode").addEventListener("change", function () {
        const original=this.value==="original";
        ["brightness","contrast","sharpness"].forEach(id=>{
            if($(id)) $(id).disabled=original;
        });
    });
    $("mode").dispatchEvent(new Event("change"));
}

/* =========================
   INITIALIZE
========================= */

renderDocumentsList();

updateDocumentControls();

drawA4();