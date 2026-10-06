from flask import Flask, render_template, request, jsonify, send_file
import base64
import io

import cv2
import numpy as np
from PIL import Image, ImageEnhance
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.lib.utils import ImageReader


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024

A4_SIZES = {
    "portrait": (2480, 3508),
    "landscape": (3508, 2480),
}


def decode_image(data_url):
    """تحويل صورة Base64 إلى OpenCV."""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]

    raw = base64.b64decode(data_url)
    array = np.frombuffer(raw, np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError("تعذر قراءة الصورة.")

    return image


def encode_png(image):
    """تحويل OpenCV إلى Base64 PNG."""
    success, buffer = cv2.imencode(".png", image)

    if not success:
        raise ValueError("تعذر إنشاء الصورة.")

    encoded = base64.b64encode(buffer.tobytes()).decode("utf-8")

    return "data:image/png;base64," + encoded


def order_points(points):
    """
    ترتيب الزوايا:
    1 أعلى يسار
    2 أعلى يمين
    3 أسفل يمين
    4 أسفل يسار
    """
    points = np.asarray(points, dtype=np.float32)

    total = points.sum(axis=1)
    difference = np.diff(points, axis=1).reshape(-1)

    top_left = points[np.argmin(total)]
    bottom_right = points[np.argmax(total)]

    top_right = points[np.argmin(difference)]
    bottom_left = points[np.argmax(difference)]

    return np.array(
        [
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        ],
        dtype=np.float32,
    )


def correct_perspective(image, points):
    """تصحيح منظور المستند اعتمادًا على أربع زوايا."""

    rectangle = order_points(points)

    top_left, top_right, bottom_right, bottom_left = rectangle

    width_bottom = np.linalg.norm(bottom_right - bottom_left)
    width_top = np.linalg.norm(top_right - top_left)

    height_right = np.linalg.norm(top_right - bottom_right)
    height_left = np.linalg.norm(top_left - bottom_left)

    width = max(20, int(round(max(width_bottom, width_top))))
    height = max(20, int(round(max(height_right, height_left))))

    destination = np.array(
        [
            [0, 0],
            [width - 1, 0],
            [width - 1, height - 1],
            [0, height - 1],
        ],
        dtype=np.float32,
    )

    matrix = cv2.getPerspectiveTransform(rectangle, destination)

    corrected = cv2.warpPerspective(
        image,
        matrix,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    return corrected


def improve_image(
    image,
    mode="color",
    brightness=1.0,
    contrast=1.0,
    sharpness=1.0,
):
    """تحسين المستند بعد تصحيح المنظور."""

    # original = تصحيح المنظور فقط، بدون أي تعديل على الصورة
    if mode == "original":
        return image.copy()

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    pil_image = Image.fromarray(rgb)

    pil_image = ImageEnhance.Brightness(
        pil_image
    ).enhance(float(brightness))

    pil_image = ImageEnhance.Contrast(
        pil_image
    ).enhance(float(contrast))

    pil_image = ImageEnhance.Sharpness(
        pil_image
    ).enhance(float(sharpness))

    if mode == "gray":
        pil_image = pil_image.convert("L").convert("RGB")

    elif mode == "scan":

        gray = np.array(pil_image.convert("L"))

        gray = cv2.GaussianBlur(
            gray,
            (3, 3),
            0,
        )

        scanned = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            21,
            10,
        )

        pil_image = Image.fromarray(
            scanned
        ).convert("RGB")

    result = cv2.cvtColor(
        np.array(pil_image),
        cv2.COLOR_RGB2BGR,
    )

    return result



def _quad_score(points, image_width, image_height):
    """درجة تقريبية لاختيار أفضل مستطيل يمثل المستند."""
    ordered = order_points(points)
    area = abs(cv2.contourArea(ordered.astype(np.float32)))
    image_area = max(1.0, float(image_width * image_height))
    area_ratio = area / image_area

    if area_ratio < 0.08:
        return -1.0

    tl, tr, br, bl = ordered
    widths = [np.linalg.norm(tr - tl), np.linalg.norm(br - bl)]
    heights = [np.linalg.norm(bl - tl), np.linalg.norm(br - tr)]

    if min(widths + heights) < 20:
        return -1.0

    opposite_similarity = (
        min(widths) / max(widths) +
        min(heights) / max(heights)
    ) / 2.0

    return area_ratio * 0.85 + opposite_similarity * 0.15


def detect_document_corners(image):
    """
    اكتشاف زوايا المستند تلقائياً.
    يعيد النقاط بالترتيب:
    أعلى يسار، أعلى يمين، أسفل يمين، أسفل يسار.
    """
    original_height, original_width = image.shape[:2]

    max_side = 1600
    resize_scale = min(
        1.0,
        max_side / float(max(original_width, original_height))
    )

    if resize_scale < 1.0:
        working = cv2.resize(
            image,
            (
                int(round(original_width * resize_scale)),
                int(round(original_height * resize_scale)),
            ),
            interpolation=cv2.INTER_AREA,
        )
    else:
        working = image.copy()

    height, width = working.shape[:2]
    gray = cv2.cvtColor(working, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    # نجرب أكثر من طريقة لاستخراج الحدود لتحسين النتائج
    edge_sets = []

    canny = cv2.Canny(gray, 45, 140)
    canny = cv2.morphologyEx(
        canny,
        cv2.MORPH_CLOSE,
        np.ones((5, 5), np.uint8),
        iterations=2,
    )
    edge_sets.append(canny)

    adaptive = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        7,
    )
    adaptive = cv2.bitwise_not(adaptive)
    adaptive = cv2.morphologyEx(
        adaptive,
        cv2.MORPH_CLOSE,
        np.ones((7, 7), np.uint8),
        iterations=2,
    )
    edge_sets.append(adaptive)

    best_points = None
    best_score = -1.0

    for edges in edge_sets:
        contours, _ = cv2.findContours(
            edges,
            cv2.RETR_LIST,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        contours = sorted(
            contours,
            key=cv2.contourArea,
            reverse=True,
        )[:40]

        for contour in contours:
            perimeter = cv2.arcLength(contour, True)

            for epsilon_factor in (0.015, 0.02, 0.025, 0.03, 0.04):
                approx = cv2.approxPolyDP(
                    contour,
                    epsilon_factor * perimeter,
                    True,
                )

                if len(approx) != 4 or not cv2.isContourConvex(approx):
                    continue

                points = approx.reshape(4, 2).astype(np.float32)
                score = _quad_score(points, width, height)

                if score > best_score:
                    best_score = score
                    best_points = points

    # إذا لم نجد رباعياً جيداً، نستعمل أكبر contour ومستطيله الأدنى.
    if best_points is None or best_score < 0.22:
        combined = cv2.bitwise_or(edge_sets[0], edge_sets[1])
        contours, _ = cv2.findContours(
            combined,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        if contours:
            largest = max(contours, key=cv2.contourArea)
            rect = cv2.minAreaRect(largest)
            box = cv2.boxPoints(rect).astype(np.float32)

            if cv2.contourArea(box) >= (width * height * 0.08):
                best_points = box

    if best_points is None:
        # فشل الاكتشاف: نرجع إطاراً آمناً قريباً من الحواف،
        # ويبقى المستخدم قادراً على تعديل النقاط يدوياً.
        margin_x = width * 0.06
        margin_y = height * 0.06
        best_points = np.array(
            [
                [margin_x, margin_y],
                [width - margin_x, margin_y],
                [width - margin_x, height - margin_y],
                [margin_x, height - margin_y],
            ],
            dtype=np.float32,
        )
        confidence = 0.0
    else:
        confidence = max(0.0, min(1.0, float(best_score)))

    ordered = order_points(best_points)

    # إعادة النقاط إلى أبعاد الصورة الأصلية
    if resize_scale != 1.0:
        ordered = ordered / resize_scale

    ordered[:, 0] = np.clip(ordered[:, 0], 0, original_width - 1)
    ordered[:, 1] = np.clip(ordered[:, 1], 0, original_height - 1)

    return ordered, confidence


def data_url_to_pil(data_url):
    """تحويل Base64 إلى Pillow."""

    if "," in data_url:
        data_url = data_url.split(",", 1)[1]

    raw = base64.b64decode(data_url)

    return Image.open(
        io.BytesIO(raw)
    ).convert("RGB")


def compose_a4(items, orientation="portrait"):
    """إنشاء صفحة A4 ووضع المستندات عليها."""

    width, height = A4_SIZES.get(
        orientation,
        A4_SIZES["portrait"],
    )

    sheet = Image.new(
        "RGB",
        (width, height),
        "white",
    )

    for item in items:

        document = data_url_to_pil(
            item["image"]
        )

        scale = max(
            0.02,
            float(item.get("scale", 1)),
        )

        rotation = float(
            item.get("rotation", 0)
        )

        x = int(
            float(item.get("x", 0))
        )

        y = int(
            float(item.get("y", 0))
        )

        new_width = max(
            10,
            int(document.width * scale),
        )

        new_height = max(
            10,
            int(document.height * scale),
        )

        document = document.resize(
            (new_width, new_height),
            Image.Resampling.LANCZOS,
        )

        if abs(rotation) > 0.01:

            document = document.rotate(
                rotation,
                expand=True,
                resample=Image.Resampling.BICUBIC,
                fillcolor="white",
            )

        # منع الخطأ إذا خرج جزء من الصورة خارج A4
        left = max(0, x)
        top = max(0, y)

        right = min(
            width,
            x + document.width,
        )

        bottom = min(
            height,
            y + document.height,
        )

        if right <= left or bottom <= top:
            continue

        cropped = document.crop(
            (
                left - x,
                top - y,
                right - x,
                bottom - y,
            )
        )

        sheet.paste(
            cropped,
            (left, top),
        )

    return sheet


@app.route("/")
def index():

    return render_template(
        "index.html"
    )


@app.route(
    "/api/detect-corners",
    methods=["POST"],
)
def detect_corners_api():
    """إرجاع زوايا المستند المقترحة تلقائياً للواجهة."""
    try:
        data = request.get_json(force=True)

        if "image" not in data:
            return jsonify(
                {"error": "لم يتم إرسال صورة."}
            ), 400

        image = decode_image(data["image"])
        points, confidence = detect_document_corners(image)

        return jsonify(
            {
                "points": [
                    {
                        "x": float(point[0]),
                        "y": float(point[1]),
                    }
                    for point in points
                ],
                "confidence": round(float(confidence), 3),
                "width": int(image.shape[1]),
                "height": int(image.shape[0]),
            }
        )

    except Exception as error:
        return jsonify(
            {"error": str(error)}
        ), 500


@app.route(
    "/api/process",
    methods=["POST"],
)
def process_document():

    try:

        data = request.get_json(
            force=True
        )

        if "image" not in data:
            return jsonify(
                {
                    "error":
                    "لم يتم إرسال صورة."
                }
            ), 400

        points = data.get(
            "points",
            []
        )

        if len(points) != 4:
            return jsonify(
                {
                    "error":
                    "يجب تحديد أربع زوايا."
                }
            ), 400

        image = decode_image(
            data["image"]
        )

        points_array = [
            [
                float(point["x"]),
                float(point["y"]),
            ]
            for point in points
        ]

        corrected = correct_perspective(
            image,
            points_array,
        )

        corrected = improve_image(
            corrected,
            mode=data.get(
                "mode",
                "color",
            ),
            brightness=float(
                data.get(
                    "brightness",
                    1,
                )
            ),
            contrast=float(
                data.get(
                    "contrast",
                    1,
                )
            ),
            sharpness=float(
                data.get(
                    "sharpness",
                    1,
                )
            ),
        )

        return jsonify(
            {
                "image":
                encode_png(corrected),

                "width":
                int(
                    corrected.shape[1]
                ),

                "height":
                int(
                    corrected.shape[0]
                ),
            }
        )

    except Exception as error:

        return jsonify(
            {
                "error":
                str(error)
            }
        ), 500


@app.route(
    "/api/export",
    methods=["POST"],
)
def export_document():

    try:

        data = request.get_json(
            force=True
        )

        items = data.get(
            "items",
            []
        )

        if not items:

            return jsonify(
                {
                    "error":
                    "لا توجد مستندات داخل A4."
                }
            ), 400

        orientation = data.get(
            "orientation",
            "portrait",
        )

        file_format = data.get(
            "format",
            "pdf",
        ).lower()

        quality = int(
            data.get(
                "quality",
                85,
            )
        )

        quality = max(
            10,
            min(
                100,
                quality,
            ),
        )

        sheet = compose_a4(
            items,
            orientation,
        )

        output = io.BytesIO()

        if file_format == "pdf":

            if orientation == "portrait":

                page_size = (
                    595.2756,
                    841.8898,
                )

            else:

                page_size = (
                    841.8898,
                    595.2756,
                )

            pdf = pdf_canvas.Canvas(
                output,
                pagesize=page_size,
            )

            temporary_image = io.BytesIO()

            sheet.save(
                temporary_image,
                format="JPEG",
                quality=quality,
                optimize=True,
            )

            temporary_image.seek(0)

            pdf.drawImage(
                ImageReader(
                    temporary_image
                ),
                0,
                0,
                width=page_size[0],
                height=page_size[1],
            )

            pdf.showPage()
            pdf.save()

            extension = "pdf"
            mime_type = (
                "application/pdf"
            )

        elif file_format in (
            "jpg",
            "jpeg",
        ):

            sheet.save(
                output,
                format="JPEG",
                quality=quality,
                optimize=True,
            )

            extension = "jpg"
            mime_type = "image/jpeg"

        elif file_format == "webp":

            sheet.save(
                output,
                format="WEBP",
                quality=quality,
                method=6,
            )

            extension = "webp"
            mime_type = "image/webp"

        else:

            sheet.save(
                output,
                format="PNG",
                optimize=True,
            )

            extension = "png"
            mime_type = "image/png"

        output.seek(0)

        return send_file(
            output,
            as_attachment=True,
            download_name=(
                f"documents-a4.{extension}"
            ),
            mimetype=mime_type,
        )

    except Exception as error:

        return jsonify(
            {
                "error":
                str(error)
            }
        ), 500


if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True,
    )