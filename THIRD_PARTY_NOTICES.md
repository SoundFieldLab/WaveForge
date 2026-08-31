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

WaveForge independently implements its model downloader, process isolation, stem evidence extraction, transition planner and renderer. No Folia application source code is included.

## Optional Python Runtime

- CPython: PSF License.
- ONNX Runtime: MIT License.
- NumPy: BSD-3-Clause License.

The optional runtime is downloaded only when the user installs the HTDemucs stem model. Asset byte lengths and SHA-256 digests are pinned in `shared/automixModelManifest.json` and verified before installation.

## DJTransGAN

- Purpose: optional experimental learned fader/EQ automation and legacy fixed-duration long mix.
- Project: https://github.com/ChenPaulYu/DJtransGAN
- WaveForge pins the source revision and verifies the known pretrained weight file before use.
- DJTransGAN is not required for AutoMix Enhanced and is disabled by default.
