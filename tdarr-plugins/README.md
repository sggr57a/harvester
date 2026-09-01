# Tdarr — True AI Upscaling & Denoising

A working, **Flow-based** setup for real AI super-resolution + artifact/denoise
removal on a video library (MKV, MP4, etc.), built by **reusing the model from
the [Jellyfin-SRGAN-Plugin](https://github.com/sggr57a/Jellyfin-SRGAN-Plugin)
project** — with a corrected model architecture so it actually works.

| File | Purpose |
|------|---------|
| `swift-srgan/swift_srgan_upscale.py` | **Corrected** self-contained Swift-SRGAN 4x CLI upscaler (reuses `swift_srgan_4x.pth`). |
| `scripts/tdarr-upscale-ai.sh` | Wrapper Tdarr calls; `ENGINE=swift-srgan` (default) or `real-esrgan`. |
| `flow-plugins/customFunction-ai-upscale.js` | Paste-in code for a Flow "Custom JS Function" node. |
| `docker/Dockerfile.tdarr-node-swiftsrgan` | **Default** Tdarr node image: CUDA + Swift-SRGAN + model. |
| `docker/Dockerfile.tdarr-node-realesrgan` | Alternative node image using Real-ESRGAN. |
| `docker/docker-compose.yml` | Example server + GPU node stack. |

---

## 1. Why the original classic plugin gave a "can't read the file" error

Your starting file was a **classic** plugin. Two issues:

**a) Wrong export shape (the actual crash).** A classic plugin must export two
separate functions, `details` and `plugin`
([docs](https://docs.tdarr.io/docs/plugins/classic-plugins/basics/)):

```js
const details = () => ({ id: '...', Stage: 'Pre-processing', /* ... */ Inputs: [] });
const plugin  = (file, librarySettings, inputs, otherArguments) => { /* ... */ };
module.exports.details = details;
module.exports.plugin  = plugin;
```

The original code did `module.exports = { id, Stage, ..., plugin: fn }`. Tdarr
loads a plugin by calling `require(file).details()`; with `details` undefined
that throws → **Read Error**.

**b) `response.customCommand` does not exist in classic plugins.** A classic
`plugin()` can only run ffmpeg/HandBrake via `response.preset`
([docs](https://docs.tdarr.io/docs/plugins/classic-plugins/plugin-components/plugin/)).
There is no field to launch an external binary. Running an external AI upscaler
is a **Flows-only** capability — which is what this setup uses.

---

## 2. Assessment of the Jellyfin-SRGAN-Plugin project

**Verdict: highly reusable — the trained model is good, but the shipped
inference code never actually ran it.** The Jellyfin-specific parts (webhook,
HLS, watchdog, C# plugin, `~60` troubleshooting `.md` files) are irrelevant to
Tdarr, but three pieces are directly reusable:

- `models/swift_srgan_4x.pth` — a real **Swift-SRGAN 4x** model (283 tensors).
- `scripts/srgan_pipeline.py` — an `<input> <output>` CLI wrapper.
- `scripts/your_model_file_ffmpeg.py` — an ffmpeg-pipe frame loop + Gaussian
  denoise + NVENC encode + audio/subtitle remux (the right *shape* of pipeline).

### The critical bug (verified)

`your_model_file_ffmpeg.py` defines the generator with **plain `Conv2d` and no
BatchNorm**. The checkpoint is a **Swift-SRGAN** network using
**depthwise-separable convolutions + BatchNorm** (`convblock.cnn.depthwise`,
`residual.N.block1.cnn.pointwise`, `initial.cnn.depthwise`, …). It is loaded
with `load_state_dict(..., strict=False)`, which silently drops every key that
doesn't match. Measured directly against the checkpoint:

```
checkpoint tensors: 283
[CORRECTED SwiftSRGAN] matched by name+shape: 283/283   (strict load: 0 missing / 0 unexpected)
[ORIGINAL code arch ] matched by name+shape:   0/283
```

So the original "AI upscaler" ran on **randomly-initialised weights** — it never
performed real super-resolution. (Two secondary issues compound it: the pipeline
default `--scale 2.0` conflicts with the 4x model, and it rewrites the output
filename with `[2160p]` tags, which breaks Tdarr's expected output path.)

### Is its original intent still possible? Yes.

The weights are fine; only the *architecture class* was wrong. This repo ships a
corrected engine, `swift-srgan/swift_srgan_upscale.py`, that:

- Defines the **correct Swift-SRGAN generator** (matches all 283 tensors, loads
  `strict=True`). Reference: [Koushik0901/Swift-SRGAN](https://github.com/Koushik0901/Swift-SRGAN).
- Keeps the good parts of their pipeline (ffmpeg frame pipe, Gaussian pre-denoise,
  NVENC, audio/subtitle/chapter remux).
- Forces the native **4x** scale, then optionally downscales to `TARGET_WIDTH`.
- Writes to the **exact** output path Tdarr passes (no filename rewriting).
- Outputs **HEVC 10-bit** (`hevc_nvenc`, `p010le`, `main10`).

Verified end-to-end on this machine (CPU/libx265): a `96x64` clip → AI `4x`
`384x256` → downscaled to the target, HEVC Main10 output, audio preserved,
`283/283` tensors loaded.

---

## 3. Architecture

```
             ┌──────────────────────── Tdarr Flow ────────────────────────┐
 Library ──► │  Input File ─► Check Video Resolution ─► Run CLI (AI script) │ ─► Replace Original File
             │                     │ (4K/8K)                                │
             │                     └────────────► (skip, do nothing)        │
             └────────────────────────────────────────────────────────────┘
                                         │
                        /usr/local/bin/tdarr-upscale-ai.sh "$input" "$output"
                                         │  (ENGINE=swift-srgan | real-esrgan)
             swift_srgan_upscale.py: decode ─► denoise ─► Swift-SRGAN 4x
                                     ─► downscale to TARGET_WIDTH ─► HEVC 10-bit + remux ─► "$output"
```

---

## 4. Make the AI tool available to the Tdarr NODE

The Tdarr **node** runs transcodes, so the engine + CUDA must live there.

### Option A — Docker (recommended)

```bash
cd tdarr-plugins
docker compose -f docker/docker-compose.yml up -d --build   # edit media/cache paths first
```

This builds `Dockerfile.tdarr-node-swiftsrgan`, which installs PyTorch (CUDA),
copies the corrected engine, downloads `swift_srgan_4x.pth`, and **verifies the
model loads strictly at build time**. Requires the NVIDIA driver +
`nvidia-container-toolkit` on the host.

### Option B — Bare-metal node

Copy `swift-srgan/swift_srgan_upscale.py` to `/opt/swift-srgan/`, place
`swift_srgan_4x.pth` next to it (or set `SRGAN_MODEL_PATH`), copy
`scripts/tdarr-upscale-ai.sh` to `/usr/local/bin/` (`chmod +x`), and install
`torch`/`numpy` plus an ffmpeg with `hevc_nvenc`.

---

## 5. Build the Flow

On the **Flows** tab:

1. **Input File** (start).
2. **Check Video Resolution** — wire **4KUHD / DCI4K / 8KUHD** to nothing (skip);
   wire the lower resolutions + **Other** onward. This is the Flow-native
   replacement for your `file.meta.width >= 3840` check.
3. **Run CLI**:
   - **Use Custom CLI Path?** → `true`
   - **Custom CLI Path** → `/usr/local/bin/tdarr-upscale-ai.sh`
   - **Does Command Create Output File?** → `true`
   - **Output File Path** → `${cacheDir}/${fileName}.mkv`
   - **CLI Arguments** → `"{{{args.inputFileObj._id}}}" "${outputFilePath}"`
   - **Output File Becomes Working File?** → `true`
4. *(optional)* a health-check / size-check node.
5. **Replace Original File** (or **Move to Directory**).

No custom code needed. Alternatively paste
`flow-plugins/customFunction-ai-upscale.js` into a **Custom JS Function** node
(it includes the 4K skip check and calls the same wrapper).

---

## 6. Tuning (environment variables on the node)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENGINE` | `swift-srgan` | `swift-srgan` (reuses bundled model) or `real-esrgan` |
| `TARGET_WIDTH` | `3840` | Output width target; downscales after 4x if wider (0 = keep full 4x) |
| `SRGAN_DENOISE` / `SRGAN_DENOISE_STRENGTH` | `1` / `0.5` | Gaussian pre-denoise / artifact removal |
| `SRGAN_FP16` | `1` | Half precision on CUDA (faster, less VRAM) |
| `NVENC_CQ` / `NVENC_PRESET` | `19` / `p6` | HEVC quality / speed |
| `SRGAN_MODEL_PATH` | `/opt/swift-srgan/swift_srgan_4x.pth` | Model weights |

Real-ESRGAN engine adds `MODEL`, `DENOISE`, `TILE`, `MAX_SCALE`, `FP32`,
`GPU_ID`, `REALESRGAN_DIR` (see the script header).

---

## 7. Open-source engine options

- **Swift-SRGAN** (default here) — https://github.com/Koushik0901/Swift-SRGAN —
  lightweight depthwise-separable SRGAN; the bundled 4x model is only ~0.9 MB.
- **Real-ESRGAN** — https://github.com/xinntao/Real-ESRGAN — stronger real-world
  restoration; `realesr-general-x4v3` has adjustable denoise. Use
  `Dockerfile.tdarr-node-realesrgan` + `ENGINE=real-esrgan`.
- **Video2X** — https://github.com/k4yt3x/video2x — all-in-one (Real-ESRGAN,
  Real-CUGAN, RIFE, Anime4K over Vulkan/ncnn); swap into the wrapper if desired.
- **Anime4K** — https://github.com/bloc97/Anime4K — very fast, anime/line-art.

---

## 8. Caveats

- **Speed/VRAM:** frame-by-frame AI upscaling is slow (often minutes per minute
  of video). Lower `TARGET_WIDTH` or use fp16 to fit VRAM/time budgets.
- **HDR:** this targets SDR→SDR at 10-bit; it does not invent HDR. Route true
  HDR/HEVC-10bit sources around the upscaler (a **Check Video Codec** = `hevc`
  node is a good extra gate).
- **Quality:** GAN upscalers can hallucinate texture. Swift-SRGAN is fast and
  light; Real-ESRGAN generally gives stronger detail on real-world footage.
