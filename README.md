# Packet Tracer Helper

Describe a network or attach a lab sheet. Packet Tracer Helper builds an editable `.pkt` using the ChatGPT account already signed in to Codex.

## Quick start

Use Windows x64 with Cisco Packet Tracer 9.0.1 and signed-in Codex. [Cisco Packet Tracer](https://www.netacad.com/resources/lab/cisco-packet-tracer) · [Sign in to Codex](https://learn.chatgpt.com/docs/auth)

1. Download the **Windows x64 ZIP**, extract all files, and open **Packet Tracer Helper.exe**. Keep the extracted folder together. [Download from GitHub Releases](https://github.com/alilbitofsoulsauce/cpt-stealth/releases/latest)
2. In the helper, choose **Set up module → Copy module path**. In Packet Tracer, open **Extensions → Scripting → Configure PT Script Modules → Add** and paste that path. If the module is stopped after adding it, select **Packet Tracer Helper** and choose **Start**. You add it once.
3. When the helper says **Packet Tracer is ready**, start with **File → New** in Packet Tracer. Enter a prompt or choose **Attach files**, then click **Build**. Use **Open lab** to open the saved `.pkt`.

> Connect two PCs through a switch on 192.168.10.0/24. Give them addresses .10 and .11 and check that they can ping each other.

Use **File → New** before each build so you can decide what to save from the previous lab. Labs go to `%LOCALAPPDATA%\PacketTracerHelper\labs`.

## VLANs and WAN links

Choose **VLAN/WAN example** in the helper for a two-site lab you can build right away. You can also paste a prompt like this:

> Build an HQ and a branch with a 2911 router and a 2960 switch at each site. Put SALES1 in HQ VLAN 10 on 10.42.10.0/24 and ENG1 in HQ VLAN 20 on 10.42.20.0/24. Put OPS1 in branch VLAN 30 on 10.42.30.0/24 and SUPPORT1 in branch VLAN 40 on 10.42.40.0/24. Use 802.1Q trunks, connect the routers with an Ethernet WAN on 10.255.0.0/30, and configure static routes to the remote VLANs. Verify SALES1 can ping ENG1 and OPS1, and OPS1 can ping SALES1 and SUPPORT1.

- A basic lab supports one 2960 switch and up to 24 PCs on one static IPv4 subnet.
- A routed lab supports one to four sites with up to eight VLANs and 23 PCs per site. Enter your subnets, VLAN IDs, gateways, and host addresses, or ask the helper to choose them. A site can have up to two point-to-point WAN links, each using its own private IPv4 `/30` subnet. The helper configures inter-VLAN routing and static routes to the remote VLANs.
- Each build supports up to 24 simulated ping checks between named PCs. The result shows how many passed, and the saved `.pkt` opens in Packet Tracer for editing.

Use static IPv4 addressing and routing for these labs. DHCP, OSPF, BGP, NAT, ACLs, IPv6, and redundant WAN links are outside the current feature set.

## PDF and image references

Add up to eight PDFs, PNGs, JPEGs, or WebP images totaling 20 MB. Include a short prompt if you want to clarify which parts to follow. The helper includes the selected references with the model request when you click **Build**.

The Codex route renders PDFs locally and reads up to 20 PDF pages and images combined. It can use Poppler from the Codex Windows runtime or a Poppler installation on `PATH`. If the renderer is unavailable, attach screenshots of the PDF pages. [Codex image inputs](https://learn.chatgpt.com/docs/image-inputs?surface=cli)

## If the helper is waiting

- **Packet Tracer:** Start the helper and Packet Tracer, then check **Configure PT Script Modules** for the registered module. If Packet Tracer asks for a connection file, choose **Copy connection path** in the helper's setup window and paste it into Packet Tracer.
- **ChatGPT:** Sign in to Codex and click **Refresh**. The helper also offers **Continue with ChatGPT** to link an eligible plan directly. [ChatGPT plan sign-in](https://developers.openai.com/siwc/quickstart)

## Run from source

Open `Start.cmd` with Node.js 22 or newer available on `PATH` or from the Codex Windows runtime. After editing the tray source, exit the app from its tray menu and run `Start.cmd --rebuild`. Run `node --test` for local tests or `pwsh -File scripts/package.ps1` to build the Windows ZIP.

## Update the Packet Tracer module

After extracting a new release, select the old **Packet Tracer Helper** entry in **Configure PT Script Modules** and choose **Remove**. Add the `.pts` from the new helper's setup window. Your saved `.pkt` labs remain in the labs folder.
