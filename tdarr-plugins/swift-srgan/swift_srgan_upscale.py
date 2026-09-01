#!/usr/bin/env python3
"""
swift_srgan_upscale.py — Corrected, self-contained Swift-SRGAN video upscaler.

This REUSES the trained model weights from the Jellyfin-SRGAN-Plugin project
(models/swift_srgan_4x.pth) but with the CORRECT network architecture.

Why this file exists
---------------------
The original scripts/your_model_file_ffmpeg.py in that project defined a plain
Conv2d SRGAN generator. The shipped checkpoint (swift_srgan_4x.pth) is a
*Swift-SRGAN* network that uses depthwise-separable convolutions + BatchNorm
(283 tensors). Loading the 4x weights into the plain-Conv2d model with
`load_state_dict(..., strict=False)` matched 0/283 tensors, so the "AI" ran on
randomly-initialised weights and never actually upscaled. This module fixes the
architecture so all 283 tensors load (strict), making the model work as intended.

It is designed to be called by Tdarr (via a Flow "Run CLI" node) exactly as:

    swift_srgan_upscale.py "<INPUT>" "<OUTPUT>"

and it writes the finished file to EXACTLY <OUTPUT> (no filename rewriting), so
Tdarr can pick it up as the new working file.

Pipeline: ffmpeg (decode -> rgb24 frames) -> optional denoise -> Swift-SRGAN 4x
-> optional downscale to TARGET_WIDTH -> ffmpeg (HEVC 10-bit NVENC) with the
original audio/subtitles/chapters muxed back in.

Environment overrides
---------------------
  SRGAN_MODEL_PATH   default /opt/swift-srgan/swift_srgan_4x.pth
  SRGAN_DEVICE       cuda|cpu   (default: cuda if available)
  SRGAN_FP16         1|0        half precision on CUDA (default 1)
  SRGAN_DENOISE      1|0        Gaussian pre-denoise (default 1)
  SRGAN_DENOISE_STRENGTH  0..1  (default 0.5)
  TARGET_WIDTH       px         downscale after 4x if wider (default 3840; 0=off)
  NVENC_ENCODER      default hevc_nvenc  (use libx265 for CPU)
  NVENC_PRESET       default p6
  NVENC_CQ           default 19
"""

import argparse
import os
import subprocess
import sys

import numpy as np
import torch
import torch.nn as nn


# --------------------------------------------------------------------------- #
# Corrected Swift-SRGAN generator (matches Koushik0901/Swift-SRGAN checkpoint). #
# --------------------------------------------------------------------------- #
class SeparableConv2d(nn.Module):
    def __init__(self, in_c, out_c, kernel_size, stride=1, padding=1, bias=True):
        super().__init__()
        self.depthwise = nn.Conv2d(in_c, in_c, kernel_size, stride, padding, groups=in_c, bias=bias)
        self.pointwise = nn.Conv2d(in_c, out_c, kernel_size=1, bias=bias)

    def forward(self, x):
        return self.pointwise(self.depthwise(x))


class ConvBlock(nn.Module):
    def __init__(self, in_c, out_c, use_act=True, use_bn=True, **kwargs):
        super().__init__()
        self.use_act = use_act
        self.cnn = SeparableConv2d(in_c, out_c, **kwargs, bias=not use_bn)
        self.bn = nn.BatchNorm2d(out_c) if use_bn else nn.Identity()
        # NOTE: the PReLU is always instantiated (even when use_act=False) to
        # match the reference weights, which store block2/convblock act params.
        self.act = nn.PReLU(num_parameters=out_c)

    def forward(self, x):
        y = self.bn(self.cnn(x))
        return self.act(y) if self.use_act else y


class UpsampleBlock(nn.Module):
    def __init__(self, channels, scale_factor):
        super().__init__()
        self.conv = SeparableConv2d(channels, channels * scale_factor ** 2, kernel_size=3, stride=1, padding=1)
        self.ps = nn.PixelShuffle(scale_factor)
        self.act = nn.PReLU(num_parameters=channels)

    def forward(self, x):
        return self.act(self.ps(self.conv(x)))


class ResidualBlock(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.block1 = ConvBlock(channels, channels, kernel_size=3, stride=1, padding=1)
        self.block2 = ConvBlock(channels, channels, kernel_size=3, stride=1, padding=1, use_act=False)

    def forward(self, x):
        return self.block2(self.block1(x)) + x


class Generator(nn.Module):
    def __init__(self, in_channels=3, num_channels=64, num_blocks=16, upscale_factor=4):
        super().__init__()
        self.initial = ConvBlock(in_channels, num_channels, kernel_size=9, stride=1, padding=4, use_bn=False)
        self.residual = nn.Sequential(*[ResidualBlock(num_channels) for _ in range(num_blocks)])
        self.convblock = ConvBlock(num_channels, num_channels, kernel_size=3, stride=1, padding=1, use_act=False)
        self.upsampler = nn.Sequential(*[UpsampleBlock(num_channels, 2) for _ in range(upscale_factor // 2)])
        self.final_conv = SeparableConv2d(num_channels, in_channels, kernel_size=9, stride=1, padding=4)

    def forward(self, x):
        initial = self.initial(x)
        x = self.residual(initial)
        x = self.convblock(x) + initial
        x = self.upsampler(x)
        return (torch.tanh(self.final_conv(x)) + 1) / 2


NATIVE_SCALE = 4


def log(*a):
    print("[swift-srgan]", *a, file=sys.stderr, flush=True)


def load_generator(model_path, device):
    if not os.path.isfile(model_path):
        raise FileNotFoundError(
            f"Swift-SRGAN model not found at {model_path}. "
            "Set SRGAN_MODEL_PATH or place swift_srgan_4x.pth there."
        )
    ckpt = torch.load(model_path, map_location=device)
    if isinstance(ckpt, dict):
        state = ckpt.get("model") or ckpt.get("state_dict") or ckpt.get("generator") or ckpt
    else:
        state = ckpt
    model = Generator(upscale_factor=NATIVE_SCALE)
    # strict=True: fail loudly if the weights do not match (the whole point).
    model.load_state_dict(state, strict=True)
    return model.eval().to(device)


def gaussian_denoise(t, strength=0.5):
    if strength <= 0:
        return t
    ksize = max(3, int(strength * 7) | 1)
    sigma = strength * 2.0
    xs = torch.arange(ksize, dtype=torch.float32, device=t.device) - (ksize - 1) / 2
    g = torch.exp(-xs ** 2 / (2 * sigma ** 2))
    g = g / g.sum()
    k2d = (g.view(-1, 1) @ g.view(1, -1)).view(1, 1, ksize, ksize)
    pad = ksize // 2
    from torch.nn.functional import conv2d, pad as fpad
    chans = [conv2d(fpad(t[:, c:c + 1], (pad, pad, pad, pad), mode="reflect"), k2d) for c in range(t.shape[1])]
    den = torch.cat(chans, dim=1)
    a = min(1.0, strength)
    return t * (1 - a) + den * a


def ffprobe_stream(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-of", "default=noprint_wrappers=1:nokey=0", path,
    ], text=True)
    info = {}
    for line in out.strip().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k] = v
    w = int(info.get("width", "0"))
    h = int(info.get("height", "0"))
    fr = info.get("r_frame_rate", "24/1")
    if "/" in fr:
        n, d = fr.split("/")
        fps = (float(n) / float(d)) if float(d) else 24.0
    else:
        fps = float(fr)
    return w, h, fps


def main():
    ap = argparse.ArgumentParser(description="Swift-SRGAN video upscaler (corrected).")
    ap.add_argument("input")
    ap.add_argument("output")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        log("ERROR: input does not exist:", args.input)
        sys.exit(2)

    model_path = os.environ.get("SRGAN_MODEL_PATH", "/opt/swift-srgan/swift_srgan_4x.pth")
    device = os.environ.get("SRGAN_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
    use_fp16 = device == "cuda" and os.environ.get("SRGAN_FP16", "1") == "1"
    denoise = os.environ.get("SRGAN_DENOISE", "1") == "1"
    denoise_strength = float(os.environ.get("SRGAN_DENOISE_STRENGTH", "0.5"))
    target_width = int(os.environ.get("TARGET_WIDTH", "3840"))
    encoder = os.environ.get("NVENC_ENCODER", "hevc_nvenc")
    nvenc_preset = os.environ.get("NVENC_PRESET", "p6")
    nvenc_cq = os.environ.get("NVENC_CQ", "19")

    sw, sh, fps = ffprobe_stream(args.input)
    if sw == 0 or sh == 0:
        log("ERROR: could not read source dimensions")
        sys.exit(2)

    up_w, up_h = sw * NATIVE_SCALE, sh * NATIVE_SCALE

    # Final size: downscale from the native 4x if it exceeds TARGET_WIDTH.
    if target_width and up_w > target_width:
        out_w = target_width - (target_width % 2)
        out_h = int(round(sh * (out_w / sw)))
        out_h -= out_h % 2
    else:
        out_w, out_h = up_w, up_h

    log(f"device={device} fp16={use_fp16} model={model_path}")
    log(f"source={sw}x{sh}@{fps:.3f}  ai_4x={up_w}x{up_h}  output={out_w}x{out_h}")

    model = load_generator(model_path, device)
    if use_fp16:
        model = model.half()
    log("model loaded (283/283 tensors, strict)")

    decode = [
        "ffmpeg", "-v", "error", "-i", args.input,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    encode = [
        "ffmpeg", "-y", "-v", "error", "-stats",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{up_w}x{up_h}", "-r", str(fps), "-i", "-",
        "-i", args.input,
        "-map", "0:v:0", "-map", "1:a?", "-map", "1:s?", "-map_chapters", "1",
    ]
    if (out_w, out_h) != (up_w, up_h):
        encode += ["-vf", f"scale={out_w}:{out_h}:flags=lanczos"]
    encode += ["-c:v", encoder]
    if "nvenc" in encoder:
        encode += ["-profile:v", "main10", "-pix_fmt", "p010le",
                   "-preset", nvenc_preset, "-rc", "vbr", "-cq", nvenc_cq, "-b:v", "0"]
    else:
        encode += ["-pix_fmt", "yuv420p10le", "-crf", "18"]
    encode += ["-c:a", "copy", "-c:s", "copy", "-map_metadata", "1", args.output]

    log("starting decode/encode pipeline...")
    dproc = subprocess.Popen(decode, stdout=subprocess.PIPE)
    eproc = subprocess.Popen(encode, stdin=subprocess.PIPE)

    frame_bytes = sw * sh * 3
    n = 0
    try:
        while True:
            if eproc.poll() is not None:
                raise RuntimeError(f"encoder exited early with code {eproc.returncode}")
            buf = dproc.stdout.read(frame_bytes)
            if not buf:
                break
            if len(buf) != frame_bytes:
                log(f"warning: partial final frame ({len(buf)} bytes), stopping")
                break
            arr = np.frombuffer(buf, dtype=np.uint8).reshape(sh, sw, 3).copy()
            t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).float().div(255).to(device)
            if denoise:
                t = gaussian_denoise(t, denoise_strength)
            with torch.no_grad():
                if use_fp16:
                    with torch.autocast("cuda", dtype=torch.float16):
                        y = model(t.half())
                else:
                    y = model(t)
            y = y.float().clamp(0, 1).mul(255).round().byte().squeeze(0).permute(1, 2, 0).cpu().numpy()
            eproc.stdin.write(y.tobytes())
            n += 1
            if n % 30 == 0:
                log(f"processed {n} frames")
    except Exception as exc:
        log("ERROR:", exc)
        for p in (dproc, eproc):
            try:
                p.kill()
            except Exception:
                pass
        sys.exit(1)
    finally:
        try:
            dproc.stdout.close()
        except Exception:
            pass
        dproc.wait()
        try:
            eproc.stdin.close()
        except Exception:
            pass
        eproc.wait()

    if eproc.returncode != 0:
        log("ERROR: encoder failed with code", eproc.returncode)
        sys.exit(1)
    if not (os.path.isfile(args.output) and os.path.getsize(args.output) > 0):
        log("ERROR: output missing/empty:", args.output)
        sys.exit(1)
    log(f"done: {n} frames -> {args.output}")


if __name__ == "__main__":
    main()
