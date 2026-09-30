# java-multibase (vendored)

`org.didcommx:peerdid` needs `com.github.multiformats:java-multibase:v1.1.0` at runtime, and only JitPack
publishes it. It is vendored here instead, so that a consumer of the SDK needs no JitPack repository
(Phase 9 W3, 5b.2).

| | |
|---|---|
| Upstream | https://github.com/multiformats/java-multibase |
| Tag | `v1.1.0` (commit `934bca9`), the version `peerdid` 0.5.0 declares |
| Files | `src/main/java` copied unchanged into `java/`, plus `LICENSE` (MIT) |
| Compiled into | `:sdk` (published inside `com.12id:holder-sdk-android`) and `:ariesframework` (its tests) |

Both modules exclude the JitPack coordinate from `peerdid`. Package `io.ipfs.multibase` stays as upstream,
because `peerdid` refers to it by name.
