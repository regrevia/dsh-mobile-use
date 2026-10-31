"""macOS Vision 文本识别常驻进程：stdin 一行一个请求，stdout 一行一个 JSON。

请求两种写法（都支持，方便手工调试）：
- 纯路径：`/tmp/a.jpg`
- JSON：`{"id": 7, "path": "/tmp/a.jpg", "max": 1600, "crop": [x, y, w, h]}`

`crop` 是原图像素、左上角原点的一块；`max` 是处理图长边上限（先裁后缩）。
返回的 `blocks` 坐标是归一化的、原点在**左下角**（Vision 的习惯），对应 `w x h` 的**处理图**；
`crop`/`ow`/`oh` 给调用方把坐标换算回原图。

不上传、不联网。空闲由 Node 侧杀掉，这里只管读一行答一行。
"""

import json
import sys
import time

import Quartz
import Vision
from Foundation import NSURL
from Quartz import (
    CGImageGetHeight,
    CGImageGetWidth,
    CGImageSourceCreateImageAtIndex,
    CGImageSourceCreateWithURL,
)


def load(path):
    src = CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    if src is None:
        raise ValueError("图片读不出来")
    image = CGImageSourceCreateImageAtIndex(src, 0, None)
    if image is None:
        raise ValueError("图片解码失败")
    return image


def crop_image(image, rect):
    full_w = CGImageGetWidth(image)
    full_h = CGImageGetHeight(image)
    x, y, w, h = rect
    x = max(0, min(int(x), full_w - 1))
    y = max(0, min(int(y), full_h - 1))
    w = max(1, min(int(w), full_w - x))
    h = max(1, min(int(h), full_h - y))
    piece = Quartz.CGImageCreateWithImageInRect(image, Quartz.CGRectMake(x, y, w, h))
    if piece is None:
        raise ValueError("裁剪失败")
    return piece, (x, y, w, h)


def scale_image(image, max_edge):
    width = CGImageGetWidth(image)
    height = CGImageGetHeight(image)
    long_edge = max(width, height)
    if max_edge <= 0 or long_edge <= max_edge:
        return image
    ratio = float(max_edge) / float(long_edge)
    width2 = max(1, int(round(width * ratio)))
    height2 = max(1, int(round(height * ratio)))
    space = Quartz.CGColorSpaceCreateDeviceRGB()
    # 5 = kCGImageAlphaNoneSkipLast：某些 pyobjc 版本不导出这个常量，直接用数值。
    context = Quartz.CGBitmapContextCreate(None, width2, height2, 8, 0, space, 5)
    if context is None:
        raise ValueError("缩放失败")
    Quartz.CGContextSetInterpolationQuality(context, Quartz.kCGInterpolationHigh)
    Quartz.CGContextDrawImage(context, Quartz.CGRectMake(0, 0, width2, height2), image)
    scaled = Quartz.CGBitmapContextCreateImage(context)
    if scaled is None:
        raise ValueError("缩放失败")
    return scaled


def recognize(path, max_edge, crop):
    original = load(path)
    ow = CGImageGetWidth(original)
    oh = CGImageGetHeight(original)
    image = original
    used = (0, 0, ow, oh)
    if crop:
        image, used = crop_image(image, crop)
    image = scale_image(image, max_edge)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(False)
    request.setRecognitionLanguages_(["zh-Hans", "en-US"])
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    handler.performRequests_error_([request], None)
    blocks = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        candidate = candidates[0]
        box = observation.boundingBox()
        blocks.append(
            {
                "text": str(candidate.string()),
                "conf": round(float(candidate.confidence()), 3),
                "x": round(float(box.origin.x), 5),
                "y": round(float(box.origin.y), 5),
                "w": round(float(box.size.width), 5),
                "h": round(float(box.size.height), 5),
            }
        )
    return {
        "blocks": blocks,
        "w": CGImageGetWidth(image),
        "h": CGImageGetHeight(image),
        "ow": ow,
        "oh": oh,
        "crop": {"x": used[0], "y": used[1], "w": used[2], "h": used[3]},
    }


def answer(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    answer({"ready": True})
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        if text == "quit":
            break
        request_id = None
        path = text
        max_edge = 0
        crop = None
        if text.startswith("{"):
            try:
                parsed = json.loads(text)
            except ValueError:
                answer({"path": text, "error": "请求不是合法 JSON"})
                continue
            request_id = parsed.get("id")
            path = str(parsed.get("path") or "")
            max_edge = int(parsed.get("max") or 0)
            raw_crop = parsed.get("crop")
            if isinstance(raw_crop, (list, tuple)) and len(raw_crop) == 4:
                crop = [int(v) for v in raw_crop]
            if not path:
                answer({"id": request_id, "path": "", "error": "缺少 path"})
                continue
        began = time.time()
        try:
            result = recognize(path, max_edge, crop)
            result["id"] = request_id
            result["path"] = path
            result["ms"] = int(round((time.time() - began) * 1000))
            answer(result)
        except Exception as exc:  # noqa: BLE001 - 出错也要答一行，不能卡住调用方
            answer(
                {
                    "id": request_id,
                    "path": path,
                    "error": str(exc)[:200],
                    "ms": int(round((time.time() - began) * 1000)),
                }
            )


if __name__ == "__main__":
    main()
