"""Generate moving transport media for the actual desktop player, independent of a prototype."""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp/quality-fixtures/media")
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--duration", type=int, default=120)
    parser.add_argument("--write-headers", action="store_true")
    args = parser.parse_args()
    if args.duration < 90:
        raise ValueError("At least 90 seconds is required for seek and resume")
    ffmpeg = str(args.ffmpeg) if args.ffmpeg else shutil.which("ffmpeg")
    if not ffmpeg and importlib.util.find_spec("imageio_ffmpeg") is not None:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    if not ffmpeg:
        raise RuntimeError("Provide --ffmpeg or install an FFmpeg runtime")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "durationSeconds": args.duration,
              "input": "FFmpeg testsrc2 and sine; no prototype or downloaded media", "outputs": []}
    heads = []
    for quality, width, height in (("480", 854, 480), ("720", 1280, 720), ("1080", 1920, 1080)):
        folder = output / quality
        folder.mkdir(parents=True, exist_ok=True)
        video = folder / "playback.mp4"
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", str(args.duration),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p", "-g", "48",
            "-keyint_min", "48", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", str(video),
        ], check=True)
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-map", "0", "-c", "copy",
            "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", str(folder / "segment-%03d.ts"), str(folder / "index.m3u8"),
        ], check=True)
        if quality == "480":
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-frames:v", "1", str(output / "poster.png")], check=True)
        head = (folder / "segment-000.ts").read_bytes()[:65536]
        heads.append({"source": f"generated-{quality}", "title": "Generated moving codec fixture", "encrypted": False,
                      "picture": f"{width}x{height}", "head": base64.b64encode(head).decode()})
        report["outputs"].append({"quality": quality, "width": width, "height": height,
                                  "files": [{"name": file.name, "bytes": file.stat().st_size,
                                             "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
                                            for file in sorted(folder.iterdir())]})
        print(f"Generated {quality}P transport media", flush=True)
    (output / "manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.write_headers:
        target = ROOT / "tv/app/src/test/resources/media-heads.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"origin": report["input"], "heads": heads}, indent=2), encoding="utf-8")
    print(f"Fixture manifest: {output / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()
