/*
 * Tdarr FLOW "Custom JS Function" node — AI upscale + denoise
 * ----------------------------------------------------------
 * Paste the ENTIRE contents of this file into the "JS Code" input of a
 * "Custom JS Function" flow plugin (Community > Tools > Custom JS Function).
 *
 * What it does, in one node:
 *   1. Skips files that are already >= 4K (returns the file unchanged on output 1).
 *   2. Otherwise runs the external AI upscaler wrapper (tdarr-upscale-ai.sh),
 *      which performs Real-ESRGAN super-resolution + denoise and encodes
 *      HEVC 10-bit, then hands the produced file back as the new working file.
 *
 * Requirements (inside the Tdarr NODE container / host — see README):
 *   - /usr/local/bin/tdarr-upscale-ai.sh  (the wrapper script, executable)
 *   - Real-ESRGAN + CUDA + ffmpeg/ffprobe available to that script
 *
 * NOTE: Prefer the built-in "Run CLI" node (see README) if you don't need
 * custom branching — it needs no code. This node is the code-based equivalent.
 */
module.exports = async (args) => {
  const { spawn } = require('child_process');
  const path = require('path');

  const SCRIPT = '/usr/local/bin/tdarr-upscale-ai.sh';
  const TARGET_WIDTH = 3840; // 4K UHD; sources at/above this are skipped

  const inputPath = args.inputFileObj._id;

  // --- Determine source width (skip if already >= 4K) ---------------------
  let width = 0;
  const streams = (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) || [];
  for (const s of streams) {
    if (s.codec_type === 'video' && Number(s.width) > width) {
      width = Number(s.width);
    }
  }

  if (width >= TARGET_WIDTH) {
    args.jobLog(`[AI Upscale] Skipping: already ${width}px wide (>= ${TARGET_WIDTH}).`);
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 1,
      variables: args.variables,
    };
  }

  // --- Build output path in the worker cache/work dir ---------------------
  const stem = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(args.workDir, `${stem}.mkv`);

  args.jobLog(`[AI Upscale] ${width}px -> AI upscaling to ~${TARGET_WIDTH}px`);
  args.jobLog(`[AI Upscale] ${SCRIPT} "${inputPath}" "${outputPath}"`);

  args.updateWorker({ CLIType: SCRIPT, preset: `"${inputPath}" "${outputPath}"` });

  // --- Run the external AI upscaler --------------------------------------
  const exitCode = await new Promise((resolve) => {
    const child = spawn(SCRIPT, [inputPath, outputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => args.jobLog(d.toString().trim()));
    child.stderr.on('data', (d) => args.jobLog(d.toString().trim()));
    child.on('error', (err) => {
      args.jobLog(`[AI Upscale] Failed to start: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(`AI upscale script exited with code ${exitCode}`);
  }

  return {
    outputFileObj: { _id: outputPath },
    outputNumber: 1,
    variables: args.variables,
  };
};
