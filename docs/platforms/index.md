# Integrated Platforms

Tessera is the sidecar. Each platform has its **own plugin repo**: install and settings live there.

Run Tessera first ([Getting Started](../getting-started/index.md)). Every plugin needs the **Tessera Base URL** and the same **ingest secret** as `TESSERA_INGEST_SECRET`.

| Platform | What the plugin does | Install and config |
|---|---|---|
| [PeerTube](https://joinpeertube.org/) | Per-second on exclusives, manual tips on free videos | [peertube-plugin-tessera](https://github.com/JaDi03/peertube-plugin-tessera) |
| [Jellyfin](https://jellyfin.org/) | Per-second on exclusives, tips on free items | [jellyfin-plugin-tessera](https://github.com/JaDi03/jellyfin-plugin-tessera) |
| [Piwigo](https://piwigo.org/) | Manual tips on public photos | [piwigo-plugin-tessera](https://github.com/JaDi03/piwigo-plugin-tessera) |

Another platform: [Connector spec](../connectors/spec.md).
