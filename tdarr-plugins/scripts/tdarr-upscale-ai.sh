#!/usr/bin/env bash
#
# tdarr-upscale-ai.sh
# -------------------
# True AI upscaler + denoiser/artifact-remover for use with a Tdarr Flow
# ("Run CLI" node or a "Custom JS Function" node).
#
# It performs REAL AI super-resolution (not a plain ffmpeg scaler), optionally
# denoises/removes compression artifacts, then muxes the original audio +
# subtitles back in and encodes to HEVC 10-bit using NVENC.
#
# Two engines are supported (choose with ENGINE=...):
#   swift-srgan  (default) Self-contained Swift-SRGAN 4x engine that reuses the
#                model from the Jellyfin-SRGAN-Plugin project. It runs the whole
#                pipeline (decode -> AI -> denoise -> HEVC 10-bit + remux) itself.
#   real-esrgan  Uses a cloned https://github.com/xinntao/Real-ESRGAN, then
#                remuxes + encodes HEVC 10-bit NVENC here.
#
# Tdarr calls it as:   tdarr-upscale-ai.sh "<INPUT_FILE>" "<OUTPUT_FILE>"
#   $1 = source file            (args.inputFileObj._id)
#   $2 = destination cache file  (${outputFilePath} from the Run CLI node)
#
# The script writes the finished file to EXACTLY $2 so Tdarr can pick it up as
# the new working file. All progress/log output goes to stderr; a non-zero exit
# code tells Tdarr the job failed (the Run CLI node throws on a non-zero code).
#
# ---------------------------------------------------------------------------
# Tunables (override via environment variables in the Tdarr node/container):
#   ENGINE           swift-srgan | real-esrgan                                 (default swift-srgan)
#   PYTHON_BIN       Python interpreter                                        (default python3)
#   TARGET_WIDTH     Desired output width in px                                (default 3840 = 4K UHD)
#   NVENC_CQ         HEVC NVENC quality (lower = better, ~18-24)               (default 19)
#   NVENC_PRESET     HEVC NVENC preset p1(fast)..p7(slow)                      (default p6)
#
#   # swift-srgan engine:
#   SWIFT_SRGAN_DIR  Dir containing swift_srgan_upscale.py                     (default /opt/swift-srgan)
#   SRGAN_MODEL_PATH Path to swift_srgan_4x.pth                                (default /opt/swift-srgan/swift_srgan_4x.pth)
#   SRGAN_DENOISE / SRGAN_DENOISE_STRENGTH / SRGAN_FP16 / SRGAN_DEVICE          (see swift_srgan_upscale.py)
#
#   # real-esrgan engine:
#   REALESRGAN_DIR   Path to a cloned Real-ESRGAN                              (default /opt/Real-ESRGAN)
#   MODEL            realesr-general-x4v3 | realesr-animevideov3 | RealESRGAN_x4plus (default realesr-general-x4v3)
#   DENOISE          Denoise strength 0..1 (realesr-general-x4v3 only)         (default 0.5)
#   MAX_SCALE        Hard cap on the AI upscale factor                         (default 4)
#   TILE             Tile size in px, lowers VRAM use (0 = off)                (default 0)
#   FP32             "1" to force fp32, "0" for fp16/half                      (default 0)
#   GPU_ID           CUDA device index                                         (default 0)
#   KEEP_TMP         "1" to keep the scratch dir for debugging                 (default 0)
# ---------------------------------------------------------------------------

set -euo pipefail

log() { printf '[tdarr-upscale-ai] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

INPUT="${1:-}"
OUTPUT="${2:-}"

[ -n "$INPUT" ]  || die "No input file given. Usage: $0 <input> <output>"
[ -n "$OUTPUT" ] || die "No output file given. Usage: $0 <input> <output>"
[ -f "$INPUT" ]  || die "Input file does not exist: $INPUT"

ENGINE="${ENGINE:-swift-srgan}"
# Resolve the Python interpreter. Prefer an explicit PYTHON_BIN, then a
# dedicated venv (recommended on PEP-668 "externally-managed" systems), then
# fall back to the system python3.
if [ -z "${PYTHON_BIN:-}" ]; then
  for _cand in /opt/swift-srgan/venv/bin/python /opt/tdarr-ai/venv/bin/python; do
    if [ -x "$_cand" ]; then PYTHON_BIN="$_cand"; break; fi
  done
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi
TARGET_WIDTH="${TARGET_WIDTH:-3840}"
NVENC_CQ="${NVENC_CQ:-19}"
NVENC_PRESET="${NVENC_PRESET:-p6}"

command -v ffmpeg  >/dev/null 2>&1 || die "ffmpeg not found on PATH"
command -v ffprobe >/dev/null 2>&1 || die "ffprobe not found on PATH"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "$PYTHON_BIN not found on PATH"

# ===========================================================================
# ENGINE: swift-srgan (default) — self-contained, reuses the bundled model.
# The Python engine performs the entire pipeline and writes directly to $OUTPUT.
# ===========================================================================
if [ "$ENGINE" = "swift-srgan" ]; then
  SWIFT_SRGAN_DIR="${SWIFT_SRGAN_DIR:-/opt/swift-srgan}"
  export SRGAN_MODEL_PATH="${SRGAN_MODEL_PATH:-$SWIFT_SRGAN_DIR/swift_srgan_4x.pth}"
  export TARGET_WIDTH NVENC_PRESET NVENC_CQ
  [ -f "$SWIFT_SRGAN_DIR/swift_srgan_upscale.py" ] \
    || die "swift_srgan_upscale.py not found in $SWIFT_SRGAN_DIR (set SWIFT_SRGAN_DIR)"
  [ -f "$SRGAN_MODEL_PATH" ] \
    || die "Swift-SRGAN model not found at $SRGAN_MODEL_PATH (set SRGAN_MODEL_PATH)"
  log "Engine: swift-srgan  model: $SRGAN_MODEL_PATH"
  exec "$PYTHON_BIN" "$SWIFT_SRGAN_DIR/swift_srgan_upscale.py" "$INPUT" "$OUTPUT"
fi

# ===========================================================================
# ENGINE: real-esrgan — external Real-ESRGAN clone, then remux + HEVC encode.
# ===========================================================================
[ "$ENGINE" = "real-esrgan" ] || die "Unknown ENGINE '$ENGINE' (use swift-srgan or real-esrgan)"

REALESRGAN_DIR="${REALESRGAN_DIR:-/opt/Real-ESRGAN}"
MODEL="${MODEL:-realesr-general-x4v3}"
DENOISE="${DENOISE:-0.5}"
MAX_SCALE="${MAX_SCALE:-4}"
TILE="${TILE:-0}"
FP32="${FP32:-0}"
GPU_ID="${GPU_ID:-0}"
KEEP_TMP="${KEEP_TMP:-0}"

[ -f "$REALESRGAN_DIR/inference_realesrgan_video.py" ] \
  || die "Real-ESRGAN not found at $REALESRGAN_DIR (set REALESRGAN_DIR)"

# --- Probe the source ------------------------------------------------------
SRC_WIDTH="$(ffprobe -v error -select_streams v:0 -show_entries stream=width \
  -of csv=p=0 "$INPUT" | head -n1 || true)"
[ -n "$SRC_WIDTH" ] || die "Could not read source width via ffprobe"
log "Source width: ${SRC_WIDTH}px, target width: ${TARGET_WIDTH}px, model: ${MODEL}"

# Compute a floating upscale factor to hit TARGET_WIDTH, clamped to [1, MAX_SCALE].
OUTSCALE="$(awk -v tw="$TARGET_WIDTH" -v sw="$SRC_WIDTH" -v mx="$MAX_SCALE" \
  'BEGIN { s = tw / sw; if (s < 1) s = 1; if (s > mx) s = mx; printf "%.4f", s }')"
log "Computed AI upscale factor: ${OUTSCALE}x"

# --- Scratch space ---------------------------------------------------------
TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/tdarr-upscale.XXXXXX")"
cleanup() { [ "$KEEP_TMP" = "1" ] || rm -rf "$TMPDIR"; }
trap cleanup EXIT

BASE="$(basename "$INPUT")"
STEM="${BASE%.*}"
SUFFIX="ai"
UPSCALED="$TMPDIR/${STEM}_${SUFFIX}.mp4"

# --- Stage 1: AI super-resolution (Real-ESRGAN, CUDA) ----------------------
REALESRGAN_ARGS=(
  "$REALESRGAN_DIR/inference_realesrgan_video.py"
  -i "$INPUT"
  -o "$TMPDIR"
  -n "$MODEL"
  -s "$OUTSCALE"
  --suffix "$SUFFIX"
  --ext mp4
)
[ "$TILE" != "0" ] && REALESRGAN_ARGS+=(--tile "$TILE")
[ "$FP32" = "1" ]  && REALESRGAN_ARGS+=(--fp32)
# -dn only affects the realesr-general-x4v3 model; harmless otherwise but we gate it.
if [ "$MODEL" = "realesr-general-x4v3" ]; then
  REALESRGAN_ARGS+=(-dn "$DENOISE")
fi

log "Stage 1/2: AI upscaling on GPU ${GPU_ID}..."
( cd "$REALESRGAN_DIR" && CUDA_VISIBLE_DEVICES="$GPU_ID" "$PYTHON_BIN" "${REALESRGAN_ARGS[@]}" ) \
  || die "Real-ESRGAN inference failed"
[ -f "$UPSCALED" ] || die "Expected upscaled file not produced: $UPSCALED"

# --- Stage 2: remux original audio/subs + encode HEVC 10-bit (NVENC) -------
# Video comes from the AI-upscaled stream; audio, subtitles, chapters and
# global metadata are copied from the ORIGINAL source so nothing is lost.
log "Stage 2/2: encoding HEVC 10-bit (NVENC) and remuxing audio/subtitles..."
ffmpeg -y -hide_banner -loglevel warning -stats \
  -i "$UPSCALED" -i "$INPUT" \
  -map 0:v:0 -map 1:a? -map 1:s? -map_chapters 1 \
  -c:v hevc_nvenc -profile:v main10 -pix_fmt p010le \
  -preset "$NVENC_PRESET" -rc vbr -cq "$NVENC_CQ" -b:v 0 \
  -c:a copy -c:s copy \
  -map_metadata 1 \
  "$OUTPUT" \
  || die "ffmpeg encode/remux failed"

[ -s "$OUTPUT" ] || die "Output file is empty: $OUTPUT"
log "Done -> $OUTPUT"
