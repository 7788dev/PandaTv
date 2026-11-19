# Where do faces sit in Douban's portraits, and which vertical framing keeps them inside a round frame?
# The frame is a circle; the photo covers it (object-fit: cover), so a portrait taller than wide is
# cropped vertically and `object-position: 50% P%` chooses the part that shows.
# Needs Python with opencv-python and numpy, and the YuNet face detector of the OpenCV model zoo
# (face_detection_yunet_2023mar.onnx, sha256 8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4).
# usage: python -I docs/evidence/portraits-measure.py <yunet model> <portraits dir> [out json]
# The result of the 2026-11-17 run is portrait-framing.json.
import json, sys, os, statistics
import numpy as np
import cv2

model_path, folder = sys.argv[1], sys.argv[2]
out_path = sys.argv[3] if len(sys.argv) > 3 else None
with open(model_path, 'rb') as handle:
    model = handle.read()
# Read from memory: paths on this host hold characters OpenCV's file functions do not take.
detector = cv2.FaceDetectorYN.create('onnx', model, b'', (320, 320), 0.6, 0.3, 50)
with open(os.path.join(folder, 'index.json'), encoding='utf-8') as handle:
    index = json.load(handle)

faces, missing, unreadable, aspects, several = [], 0, 0, [], 0
for person in index['people']:
    data = np.fromfile(os.path.join(folder, person['file']), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        unreadable += 1
        continue
    height, width = image.shape[:2]
    aspects.append(width / height)
    # The detector works at a moderate size; the photos are 150 to 600 px wide.
    scale = 480 / max(width, height)
    small = cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))))
    detector.setInputSize((small.shape[1], small.shape[0]))
    _, found = detector.detect(small)
    if found is None or not len(found):
        missing += 1
        continue
    if len(found) > 1:
        several += 1
    best = max(found, key=lambda row: row[14])
    x, y, w, h = (float(value) / scale for value in best[:4])
    faces.append({'id': person['id'], 'category': person.get('category'), 'width': width, 'height': height, 'x': x, 'y': y, 'w': w, 'h': h, 'score': float(best[14])})

def frame(face, position):
    """The face box in frame units (the frame is 1 x 1, its circle has radius 0.5) for a vertical position in 0..1."""
    width, height = face['width'], face['height']
    if height >= width:
        size = width  # the frame's side in photo pixels
        left, top = 0.0, position * (height - width)
    else:
        size = height
        left, top = 0.5 * (width - height), 0.0
    return (face['x'] - left) / size, (face['y'] - top) / size, face['w'] / size, face['h'] / size

def inside(px, py):
    return (px - 0.5) ** 2 + (py - 0.5) ** 2 <= 0.25

GRID = [(-1 + 2 * (i + 0.5) / 24) for i in range(24)]
UNIT = [(u, v) for u in GRID for v in GRID if u * u + v * v <= 1]

def shown(cx, cy, rx, ry):
    """The share of an oval's area that lies in the frame's circle."""
    return sum(1 for u, v in UNIT if inside(cx + u * rx, cy + v * ry)) / len(UNIT)

rows = []
for percent in range(0, 55, 5):
    position = percent / 100
    whole = hair = chin = brow = 0
    centres, face_shown, head_shown = [], [], []
    for face in faces:
        x, y, w, h = frame(face, position)
        corners = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)]
        if all(inside(*corner) for corner in corners):
            whole += 1
        # A face is an oval in its box; a head is the face and the hair above it.
        face_shown.append(shown(x + w / 2, y + h / 2, w / 2, h / 2))
        head_shown.append(shown(x + w / 2, y + h / 2 - 0.175 * h, w / 2 * 1.15, h / 2 * 1.35))
        # The detector's box runs from about the hairline to the chin: the hair is above it.
        if inside(x + w / 2, y - 0.35 * h):
            hair += 1
        if y + h > 1.0:
            chin += 1
        if y < 0.0:
            brow += 1
        centres.append(y + h / 2)
    total = len(faces)
    rows.append({'position': percent, 'faceInside': round(100 * whole / total, 1), 'hairInside': round(100 * hair / total, 1), 'chinCut': round(100 * chin / total, 1), 'browCut': round(100 * brow / total, 1),
                 'centreMedian': round(statistics.median(centres), 3), 'centreP10': round(float(np.percentile(centres, 10)), 3), 'centreP90': round(float(np.percentile(centres, 90)), 3),
                 'faceShown': round(100 * statistics.mean(face_shown), 1), 'faceWhole': round(100 * sum(1 for value in face_shown if value >= 0.98) / total, 1),
                 'headShown': round(100 * statistics.mean(head_shown), 1), 'headMostly': round(100 * sum(1 for value in head_shown if value >= 0.9) / total, 1)})

tall = [face for face in faces if face['height'] >= face['width']]
summary = {
    'sampledAt': index.get('at'), 'titles': index.get('titles'), 'rows': index.get('rows'), 'withoutPhoto': index.get('silhouettes'),
    'portraits': len(index['people']), 'unreadable': unreadable, 'noFace': missing, 'severalFaces': several, 'faces': len(faces),
    'aspect': {'median': round(statistics.median(aspects), 3), 'p10': round(float(np.percentile(aspects, 10)), 3), 'p90': round(float(np.percentile(aspects, 90)), 3), 'widerThanTall': sum(1 for value in aspects if value > 1)},
    # In the photo itself, as shares of its height.
    'faceTop': {'median': round(statistics.median(face['y'] / face['height'] for face in tall), 3), 'p10': round(float(np.percentile([face['y'] / face['height'] for face in tall], 10)), 3), 'p90': round(float(np.percentile([face['y'] / face['height'] for face in tall], 90)), 3)},
    'faceBottom': {'median': round(statistics.median((face['y'] + face['h']) / face['height'] for face in tall), 3), 'p10': round(float(np.percentile([(face['y'] + face['h']) / face['height'] for face in tall], 10)), 3), 'p90': round(float(np.percentile([(face['y'] + face['h']) / face['height'] for face in tall], 90)), 3)},
    'faceHeight': {'median': round(statistics.median(face['h'] / face['width'] for face in tall), 3)},
    'positions': rows,
}
print(json.dumps({key: value for key, value in summary.items() if key != 'positions'}, ensure_ascii=False))
print('position  boxInside%  hairTop%  chinCut%  browCut%  centre(median p10 p90)   faceOvalShown%(mean) faceOvalWhole%  headShown%(mean) head>=90%')
for row in rows:
    print(f"{row['position']:>7}%  {row['faceInside']:>9}  {row['hairInside']:>8}  {row['chinCut']:>8}  {row['browCut']:>8}  {row['centreMedian']} {row['centreP10']} {row['centreP90']}   {row['faceShown']:>8} {row['faceWhole']:>14}  {row['headShown']:>10} {row['headMostly']:>9}")
if out_path:
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=1)
