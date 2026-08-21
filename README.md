# Portman

English | [简体中文](./README.zh-CN.md)

Portman is a Windows desktop port manager for inspecting and tracking Windows and WSL listeners, as well as inspecting, creating, and managing Windows PortProxy mappings.

## Features

- Discover Windows TCP/UDP listeners, processes, and executable paths.
- Discover listeners in running WSL distributions.
- Group IPv4/IPv6 bindings and matching WSL/`wslrelay.exe` listeners by port.
- Hide UDP listeners and Windows system services by default, with independent filters to reveal them.
- Display external endpoints and forwarding status from the live Windows PortProxy state rather than configuration alone.
- Highlight services exposed through non-loopback bindings or external mappings.
- Create, enable, disable, and delete PortProxy mappings managed by Portman.
- Use `v4tov4` and `127.0.0.1` by default, with other proxy types and addresses available under advanced options.
- Open a Windows process executable directory from its context menu.
- Switch between English and Simplified Chinese; English is the default.
- Store configuration in `%USERPROFILE%\.portman\config.yaml`.

## Running the Application

The release `portman.exe` runs as a standalone application. Node.js, pnpm, and Rust are not required on the target machine.

Microsoft Edge WebView2 Runtime is required and is normally included with Windows 10 and Windows 11. Inspecting ports usually does not require administrator privileges. Portman requests UAC elevation only when a Windows PortProxy rule must be changed. WSL discovery requires WSL to be installed.

## Development Requirements

- Windows 10 or Windows 11
- Node.js 20+
- pnpm 10+
- Stable Rust toolchain
- Microsoft Edge WebView2 Runtime and the MSVC build tools required by Tauri 2

Install dependencies and start the development application:

```powershell
pnpm install
pnpm tauri dev
```

Build the frontend:

```powershell
pnpm build
```

Run the Rust tests:

```powershell
cd src-tauri
cargo test
```

Build the standalone release executable:

```powershell
cd src-tauri
cargo build --release
```

The executable is written to `src-tauri/target/release/portman.exe`.

See [docs/design/README.md](./docs/design/README.md) for the design documentation.
