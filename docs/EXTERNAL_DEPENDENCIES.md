# 不可重建的外部二进制依赖

用户于 2026-09-29 确认：没有另存以下资源的私有源码或编译脚本。旧源码目录和 Git 历史核对也未找到对应私有源码。以下文件是必须保留的输入，不是可清理的构建缓存。

| 文件 | 使用范围 | 管理方式 |
| --- | --- | --- |
| `public/js/scrapers.bin` | 共享抓取资源 | 已跟踪；打包时随 public 保留 |
| `src-tauri/native/windows/morisec.obj` | Windows 原生核心 | 已跟踪；由 src-tauri/build.rs 链接 |
| `src-tauri/native/darwin/libmorisec.a` | 现存 macOS 原生核心 | 已跟踪；保留原文件，本轮未验证 macOS |
| `android/app/src/main/jniLibs/arm64-v8a/libmorisec.so` | Android arm64 | 已跟踪；按现有 ABI 打包 |
| `android/app/src/main/jniLibs/armeabi-v7a/libmorisec.so` | Android armv7 | 已跟踪；按现有 ABI 打包 |
| `android/app/src/main/jniLibs/x86_64/libmorisec.so` | Android x86_64 | 已跟踪；按现有 ABI 打包 |

## 开发边界

- 现有 Windows/Android 壳、共享界面、Planner、同步和云端代码可在本仓库继续修改、测试和构建。以上二进制按现有接口使用。
- 无法从本仓库重新生成这些资源，无法承诺修改其内部实现、添加新的原生 ABI 或修复其内部缺陷。新编译器或平台版本与它们的兼容性需实际构建确认。
- 不创建虚假的 compile:scrapers 命令，不将缺失源码写成可恢复或可再生成。
- 后续若需变更核心，应取得来源方的源码/新二进制，或另行评估替代实现；替换前记录来源、接口、授权与实际兼容验证。当前资源来源版本和单独授权资料未确认，不编造版本号。

## 配置与工具链

Node 依赖由 package.json/package-lock.json 管理；本机还需 Rust/MSVC/Windows SDK、JDK、Android SDK/NDK。它们是开发工具，不应依赖其他 Mori 源码目录。Android SDK 与 JDK 路径通过 ANDROID_HOME/ANDROID_SDK_ROOT、JAVA_HOME 或忽略的本地配置指定。

Android Release 需要项目外 `%USERPROFILE%\.mori\android-signing.properties` 及对应 keystore。现有签名材料、Windows DPAPI 凭据和用户 profile 都不入 Git，不作为清理候选。克隆源码不会自动获得本机签名凭据或用户数据。

云端运行还需要已有 Cloudflare 账号、Worker/Pages/D1/R2 资源与相应本机 CLI/认证；源码在 cloudflare/，示例配置可跟踪，真实本机配置与 token 保持项目外或忽略。本次没有部署或改动线上资源，离线数据库/HTTP模拟通过不等于线上同步通过。
