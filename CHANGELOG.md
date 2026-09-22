# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.3.0](https://github.com/vbz-gg/clockwork2/compare/v0.2.0...v0.3.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* **dmath:** copysign refuses a NaN

### Bug Fixes

* **dmath:** copysign refuses a NaN ([1b11c32](https://github.com/vbz-gg/clockwork2/commit/1b11c32ce54dfc75d223407bae96d981f6ebd80f))
* **release:** bump the skill's API reference with the kernel version ([8491aca](https://github.com/vbz-gg/clockwork2/commit/8491acabf9aa1c268ee0cefcbd0e738582dc61d4))


### Documentation

* add the demo video to the README ([609be72](https://github.com/vbz-gg/clockwork2/commit/609be72afd5dff7448ec62608e8f82c0b19d450d))
* badges, and what determinism does and does not cover ([f63fef8](https://github.com/vbz-gg/clockwork2/commit/f63fef8fffd70bc3a72fa31cb44f8a81c4e04bb5))
* drop the orphaned demo poster ([a72dd30](https://github.com/vbz-gg/clockwork2/commit/a72dd30e77cbe5f5a03056ade961b52821c5db86))


### CI

* run the suite on arm64 ([df47b45](https://github.com/vbz-gg/clockwork2/commit/df47b45b7d4f0cc15488698df122159662a6ae25))

## 0.2.0 (2026-09-22)


### ⚠ BREAKING CHANGES

* remove the Clockwork 1 compat layer (#2)

### Bug Fixes

* **ci:** pin the working tree to LF so a Windows checkout keeps the golden bytes ([#6](https://github.com/vbz-gg/clockwork2/issues/6)) ([6c8e1c2](https://github.com/vbz-gg/clockwork2/commit/6c8e1c2a43ffbb8a71e7cb818c3c20be2d8c142f))
* **dmath:** a golden vector pins that a result is a NaN, not which NaN ([0fac4f8](https://github.com/vbz-gg/clockwork2/commit/0fac4f879cdafc46a92935854b4931a6a0cf4769))
* **dmath:** the tan oracle bound was measuring Apple's libm, not dmath ([07c42b5](https://github.com/vbz-gg/clockwork2/commit/07c42b57468187bc734e0fdc5c20d7da49663723))
* **host-bridge:** a session ends once, and restore publish provenance ([#9](https://github.com/vbz-gg/clockwork2/issues/9)) ([309075a](https://github.com/vbz-gg/clockwork2/commit/309075a3d631ea91cf88d84c13f4b94908c0f1eb)), closes [#7](https://github.com/vbz-gg/clockwork2/issues/7) [#7](https://github.com/vbz-gg/clockwork2/issues/7)
* **publish:** stop npm rewriting the manifest, and let a laptop pass an OTP ([60e781f](https://github.com/vbz-gg/clockwork2/commit/60e781f7fedef15aed00e770f6963a859585aefc))
* wire the release scripts that were never written ([67a0b9c](https://github.com/vbz-gg/clockwork2/commit/67a0b9c41c736cdd3d6319faf06ce07f10035c39))


### Refactoring

* **demo:** rebuild the control panel around what is happening ([#5](https://github.com/vbz-gg/clockwork2/issues/5)) ([aa9f1c1](https://github.com/vbz-gg/clockwork2/commit/aa9f1c1aca18a7e7ca403f26f6ba1d4fa4294533)), closes [#cw2](https://github.com/vbz-gg/clockwork2/issues/cw2) [#cw2](https://github.com/vbz-gg/clockwork2/issues/cw2)
* one package, @clockwork2/engine ([#12](https://github.com/vbz-gg/clockwork2/issues/12)) ([4c9df29](https://github.com/vbz-gg/clockwork2/commit/4c9df29b543e185bf855a305f31acedad4e327d6))
* remove the Clockwork 1 compat layer ([#2](https://github.com/vbz-gg/clockwork2/issues/2)) ([a590101](https://github.com/vbz-gg/clockwork2/commit/a5901014ef7061bed7bc9b52add449839a370bb5))


### CI

* publish the demo to GitHub Pages ([#4](https://github.com/vbz-gg/clockwork2/issues/4)) ([660973d](https://github.com/vbz-gg/clockwork2/commit/660973d5c25c5b5e19c7e0e31ff3d18c068d380d))
* **release:** publish through npm trusted publishing ([#11](https://github.com/vbz-gg/clockwork2/issues/11)) ([4c5c331](https://github.com/vbz-gg/clockwork2/commit/4c5c3318e550e90649b8d2f6247a45bbc86025e9))
