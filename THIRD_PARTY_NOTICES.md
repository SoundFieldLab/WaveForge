# Third-Party Notices

WaveForge includes or can optionally download third-party software and model weights. Those components remain under their respective licenses.

## Beat This!

- Purpose: beat and downbeat analysis for AutoMix.
- Project: https://github.com/CPJKU/beat_this
- ONNX export used by the optional model distribution: https://github.com/mosynthkey/beat_this_cpp
- License: MIT.

## HTDemucs

- Purpose: optional four-stem separation for AutoMix Enhanced. WaveForge uses the model only to separate short transition windows into drums, bass, vocals and residual instruments.
- Original project: https://github.com/facebookresearch/demucs
- ONNX model source: https://huggingface.co/itamiArika/htdemucs-int8-memory
- License declared by the distributed model manifest: MIT.
- Download mirror repository: https://huggingface.co/HUAI4236/folia-models

WaveForge independently implements its model downloader, process isolation, stem evidence extraction, transition planner and renderer. The Folia-derived presentation code included under `src/vendor/folia/` retains its upstream notices and licensing metadata.

## Optional Python Runtime

- CPython: PSF License.
- ONNX Runtime: MIT License.
- NumPy: BSD-3-Clause License.

The optional runtime is downloaded only when the user installs the HTDemucs stem model. Asset byte lengths and SHA-256 digests are pinned in `shared/automixModelManifest.json` and verified before installation.

## Bundled Fonts

- LXGW WenKai: SIL Open Font License 1.1. Full license: `src/assets/fonts/OFL-LXGWWenKai.txt`.
- Smiley Sans: SIL Open Font License 1.1. Full license: `src/assets/fonts/OFL-SmileySans.txt`.

## Weather Visual Assets

- `moon.webp`: adapted from Gregory H. Revera's `FullMoon2010.jpg`, CC BY-SA 3.0.
- `sky-night.jpg`: adapted from ForestWander's West Virginia night-sky photograph, CC BY-SA 3.0 US; requested attribution: http://www.ForestWander.com.
- `sky-day.jpg`: adapted from Wikimedia Commons `Sky Clouds Sea.jpg`, CC0 1.0.

Source URLs and detailed modification notes are recorded in `src/assets/weather/CREDITS.md`.

## DJTransGAN

- Purpose: optional experimental learned fader/EQ automation and legacy fixed-duration long mix.
- Project: https://github.com/ChenPaulYu/DJtransGAN
- WaveForge pins the source revision and verifies the known pretrained weight file before use.
- DJTransGAN is not required for AutoMix Enhanced and is disabled by default.
