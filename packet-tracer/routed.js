// This file is bundled into the installation-level Packet Tracer Script Module.
// All IOS commands below are compiled from a validated, structured lab plan.

function routedName(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value)) {
        throw new Error(label + " needs a valid device name.");
    }
    return value;
}

function routedAddress(value) {
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) {
        throw new Error("A routed lab contains an invalid IPv4 address.");
    }
    var address = 0;
    value.split(".").forEach(function (part) {
        var octet = Number(part);
        if (octet > 255) throw new Error("An IPv4 octet exceeds 255.");
        address = address * 256 + octet;
    });
    return address;
}

function routedNetwork(item, label) {
    if (!item || typeof item.network !== "string" || typeof item.mask !== "string") {
        throw new Error(label + " needs an IPv4 network and subnet mask.");
    }
    var network = routedAddress(item.network);
    var mask = routedAddress(item.mask);
    var hostMask = 4294967295 - mask;
    if (hostMask < 3 || (hostMask & (hostMask + 1)) !== 0 || network % (hostMask + 1) !== 0) {
        throw new Error(label + " needs a canonical IPv4 network and contiguous mask.");
    }
    var prefix = 32 - Math.round(Math.log(hostMask + 1) / Math.LN2);
    if (item.subnet !== undefined && item.subnet !== item.network + "/" + prefix) {
        throw new Error(label + " has inconsistent subnet fields.");
    }
    return {network: network, last: network + hostMask, prefix: prefix};
}

function routedHost(address, subnet, label) {
    var value = routedAddress(address);
    var firstOctet = Math.floor(value / 16777216);
    if (value <= subnet.network || value >= subnet.last || firstOctet === 0 ||
            firstOctet === 127 || firstOctet >= 224) {
        throw new Error(label + " needs a usable IPv4 host in its subnet.");
    }
    return value;
}

function validateRoutedPlan(topology) {
    if (!topology || topology.schemaVersion !== 2 || !Array.isArray(topology.sites) ||
            topology.sites.length < 1 || topology.sites.length > 4 ||
            !Array.isArray(topology.wanLinks) || !Array.isArray(topology.pings)) {
        throw new Error("A routed lab needs 1–4 sites, WAN links, and connectivity checks.");
    }
    var names = Object.create(null);
    var sites = Object.create(null);
    var endpoints = Object.create(null);
    var subnets = [];

    function reserveName(name) {
        routedName(name, "Device");
        if (names[name.toLowerCase()]) throw new Error("Duplicate device name " + name + ".");
        names[name.toLowerCase()] = true;
    }

    function reserveSubnet(subnet, label) {
        subnets.forEach(function (existing) {
            if (subnet.network <= existing.last && existing.network <= subnet.last) {
                throw new Error(label + " overlaps another lab subnet.");
            }
        });
        subnets.push(subnet);
    }

    topology.sites.forEach(function (site) {
        if (!site || typeof site.name !== "string" || !site.name || site.name.length > 100 ||
                /[\x00-\x1f\x7f]/.test(site.name) || sites[site.name] ||
                !Array.isArray(site.vlans) || site.vlans.length < 1 || site.vlans.length > 23 ||
                !Array.isArray(site.routes)) {
            throw new Error("Each site needs a unique name, VLANs, and static routes.");
        }
        reserveName(site.routerName);
        reserveName(site.switchName);
        var vlanIds = Object.create(null);
        var ports = Object.create(null);
        var pcCount = 0;
        sites[site.name] = {site: site, wanPorts: Object.create(null), nextHops: Object.create(null)};

        site.vlans.forEach(function (vlan) {
            if (!vlan || typeof vlan.id !== "number" || vlan.id % 1 || vlan.id < 1 ||
                    vlan.id > 4094 || (vlan.id >= 1002 && vlan.id <= 1005) || vlanIds[vlan.id] ||
                    typeof vlan.name !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(vlan.name) ||
                    !Array.isArray(vlan.pcs)) {
                throw new Error("Each VLAN needs a unique usable VLAN ID, name, and PCs.");
            }
            vlanIds[vlan.id] = true;
            var subnet = routedNetwork(vlan, "VLAN " + vlan.id);
            reserveSubnet(subnet, "VLAN " + vlan.id);
            var addresses = Object.create(null);
            addresses[routedHost(vlan.gateway, subnet, "VLAN gateway")] = true;
            vlan.pcs.forEach(function (pc) {
                if (!pc) throw new Error("Invalid PC in routed lab.");
                reserveName(pc.name);
                if (typeof pc.switchPort !== "string" ||
                        !/^FastEthernet0\/([1-9]|1\d|2[0-3])$/.test(pc.switchPort) || ports[pc.switchPort]) {
                    throw new Error("Each PC needs its own switch port from FastEthernet0/1 through 0/23.");
                }
                var address = routedHost(pc.ipv4, subnet, pc.name);
                if (addresses[address]) throw new Error("Duplicate IPv4 address " + pc.ipv4 + ".");
                addresses[address] = true;
                ports[pc.switchPort] = true;
                endpoints[pc.name] = true;
                pcCount++;
            });
        });
        if (pcCount > 23) throw new Error("A routed site's switch has 23 available PC ports.");
    });

    topology.wanLinks.forEach(function (link) {
        if (!link || typeof link.from !== "string" || typeof link.to !== "string" ||
                !sites[link.from] || !sites[link.to] || link.from === link.to ||
                !/^GigabitEthernet0\/[12]$/.test(link.fromPort) ||
                !/^GigabitEthernet0\/[12]$/.test(link.toPort)) {
            throw new Error("A WAN link must join two sites through GigabitEthernet0/1 or 0/2.");
        }
        var from = sites[link.from];
        var to = sites[link.to];
        if (from.wanPorts[link.fromPort] || to.wanPorts[link.toPort]) {
            throw new Error("A router WAN port is used more than once.");
        }
        var subnet = routedNetwork(link, "WAN link");
        if (subnet.prefix !== 30) throw new Error("An Ethernet point-to-point WAN uses a /30 subnet.");
        reserveSubnet(subnet, "WAN link");
        var fromAddress = routedHost(link.fromIpv4, subnet, "WAN source");
        var toAddress = routedHost(link.toIpv4, subnet, "WAN destination");
        if (fromAddress === toAddress) throw new Error("WAN addresses must differ.");
        from.wanPorts[link.fromPort] = link.fromIpv4;
        to.wanPorts[link.toPort] = link.toIpv4;
        from.nextHops[link.toIpv4] = true;
        to.nextHops[link.fromIpv4] = true;
    });

    topology.sites.forEach(function (site) {
        site.routes.forEach(function (route) {
            routedNetwork(route, "Static route");
            routedAddress(route.nextHop);
            if (!sites[site.name].nextHops[route.nextHop]) {
                throw new Error("A static route next hop must be a neighbor on this site's WAN.");
            }
        });
    });
    topology.pings.forEach(function (check) {
        if (!check || typeof check.from !== "string" || typeof check.to !== "string" ||
                !endpoints[check.from] || !endpoints[check.to] || check.from === check.to) {
            throw new Error("Connectivity checks must name two different PCs in the routed lab.");
        }
    });
}

function routedRouterCommands(site, wanLinks) {
    var commands = ["configure terminal", "hostname " + site.routerName,
        "interface GigabitEthernet0/0", "no shutdown", "exit"];
    site.vlans.forEach(function (vlan) {
        commands.push("interface GigabitEthernet0/0." + vlan.id,
            "encapsulation dot1Q " + vlan.id + (vlan.id === 1 ? " native" : ""),
            "ip address " + vlan.gateway + " " + vlan.mask,
            "exit");
    });
    wanLinks.forEach(function (link) {
        if (link.from === site.name) {
            commands.push("interface " + link.fromPort,
                "ip address " + link.fromIpv4 + " " + link.mask, "no shutdown", "exit");
        } else if (link.to === site.name) {
            commands.push("interface " + link.toPort,
                "ip address " + link.toIpv4 + " " + link.mask, "no shutdown", "exit");
        }
    });
    site.routes.forEach(function (route) {
        commands.push("ip route " + route.network + " " + route.mask + " " + route.nextHop);
    });
    commands.push("end", "write memory");
    return commands;
}

function routedSwitchCommands(site) {
    var commands = ["configure terminal", "hostname " + site.switchName];
    if (site.vlans.some(function (vlan) { return vlan.id > 1005; })) {
        commands.push("vtp mode transparent");
    }
    site.vlans.forEach(function (vlan) {
        commands.push("vlan " + vlan.id, "name " + vlan.name, "exit");
        vlan.pcs.forEach(function (pc) {
            commands.push("interface " + pc.switchPort, "switchport mode access",
                "switchport access vlan " + vlan.id, "spanning-tree portfast", "exit");
        });
    });
    commands.push("interface FastEthernet0/24", "switchport mode trunk", "switchport trunk allowed vlan none");
    // Packet Tracer 9.0.1 can accept a comma list without applying its extended VLANs.
    site.vlans.forEach(function (vlan) {
        commands.push("switchport trunk allowed vlan add " + vlan.id);
    });
    commands.push("end", "write memory");
    return commands;
}

function routedCable(job, workspace, fromDevice, fromPortName, toDevice, toPortName, cableType) {
    var fromPort = fromDevice.getPort(fromPortName);
    var toPort = toDevice.getPort(toPortName);
    if (!fromPort || !toPort || !workspace.createLink(fromDevice.getName(), fromPortName,
            toDevice.getName(), toPortName, cableType)) {
        throw new Error("Could not cable " + fromDevice.getName() + " " + fromPortName +
            " to " + toDevice.getName() + " " + toPortName + ".");
    }
    job.routedLinks.push({from: fromPort, to: toPort, label: fromDevice.getName() + " " + fromPortName});
}

function buildRoutedTopology(job, network, workspace) {
    var topology = job.request.topology;
    validateRoutedPlan(topology);
    job.network = network;
    job.endpoints = Object.create(null);
    job.routedSites = Object.create(null);
    job.routedDevices = [];
    job.routedLinks = [];
    job.routedExpected = Object.create(null);
    job.modifiedWorkspace = true;

    var columns = topology.sites.length === 3 ? 3 : 2;
    topology.sites.forEach(function (site, siteIndex) {
        var x = 190 + (siteIndex % columns) * 650;
        var y = 110 + Math.floor(siteIndex / columns) * 570;
        var router = addDevice(workspace, network, 0, ["2911"], site.routerName, x + 180, y);
        var ethernetSwitch = addDevice(workspace, network, 1, ["2960-24TT"], site.switchName, x + 180, y + 120);
        var state = {site: site, router: router, ethernetSwitch: ethernetSwitch};
        job.routedSites[site.name] = state;
        job.routedExpected[site.routerName] = "2911";
        job.routedExpected[site.switchName] = "2960-24TT";

        [router, ethernetSwitch].forEach(function (device) {
            device.setPower(true);
            device.skipBoot();
            job.routedDevices.push({device: device, name: String(device.getName()),
                index: 0, readyAt: Date.now() + 1000});
        });
        job.routedDevices[job.routedDevices.length - 2].commands = routedRouterCommands(site, topology.wanLinks);
        job.routedDevices[job.routedDevices.length - 1].commands = routedSwitchCommands(site);
        routedCable(job, workspace, router, "GigabitEthernet0/0", ethernetSwitch, "FastEthernet0/24", 8100);

        var pcIndex = 0;
        site.vlans.forEach(function (vlan) {
            vlan.pcs.forEach(function (pc) {
                var device = addDevice(workspace, network, 8, ["PC-PT"], pc.name,
                    x + (pcIndex % 6) * 80, y + 245 + Math.floor(pcIndex / 6) * 75);
                pcIndex++;
                var port = device.getPort("FastEthernet0");
                port.setIpSubnetMask(pc.ipv4, vlan.mask);
                port.setDefaultGateway(vlan.gateway);
                if (String(port.getIpAddress()) !== pc.ipv4 || String(port.getSubnetMask()) !== vlan.mask) {
                    throw new Error("Could not configure IPv4 on " + pc.name + ".");
                }
                job.endpoints[pc.name] = {device: device, port: port, ipv4: pc.ipv4};
                job.routedExpected[pc.name] = "PC-PT";
                routedCable(job, workspace, device, "FastEthernet0", ethernetSwitch, pc.switchPort, 8100);
            });
        });
    });

    topology.wanLinks.forEach(function (link) {
        routedCable(job, workspace, job.routedSites[link.from].router, link.fromPort,
            job.routedSites[link.to].router, link.toPort, 8101);
    });
    job.phase = "routed-config";
    job.routedDeadline = Date.now() + 150000;
}

function routedCommandError(state, command, output) {
    return new Error(state.name + " rejected \"" + command + "\". " +
        output.replace(/[\r\n]+/g, " ").substring(0, 240));
}

function advanceRoutedConsole(state, now) {
    if (now < state.readyAt || state.index >= state.commands.length) return;
    var command = state.commands[state.index];
    // CiscoDevice has a parser session independent of the visible console.
    // The initial mode is explicit. Blank mode retains VLAN/interface context.
    var mode = command === "configure terminal" || command === "write memory" ? "enable" : "";
    var response = state.device.enterCommand(command, mode);
    if (!response || response.first === undefined || Number(response.first) !== 0) {
        throw routedCommandError(state, command, response ? String(response.second || "Unknown IOS parser status.") : "No parser response.");
    }
    var output = String(response.second || "");
    if (/%\s*(Invalid input|Incomplete command|Ambiguous command|Unrecognized command)/i.test(output)) {
        throw routedCommandError(state, command, output);
    }
    state.index++;
}

function verifyRoutedInventory(job) {
    var expected = Object.create(null);
    Object.keys(job.routedExpected).forEach(function (name) { expected[name] = job.routedExpected[name]; });
    var unexpected = [];
    var count = Number(job.network.getDeviceCount());
    for (var index = 0; index < count; index++) {
        var device = job.network.getDeviceAt(index);
        var name = String(device.getName());
        var model = String(device.getModel());
        if (model === "Power Distribution Device" && /^Power ?Distribution ?Device\d+$/.test(name)) continue;
        if (expected[name] === model) delete expected[name];
        else unexpected.push(name + " (" + model + ")");
    }
    if (unexpected.length || Object.keys(expected).length) {
        throw new Error("Routed lab device inventory differs from the requested plan.");
    }
    job.routedLinks.forEach(function (link) {
        var from = link.from.getLink();
        var to = link.to.getLink();
        if (!from || !to || String(from.getObjectUuid()) !== String(to.getObjectUuid())) {
            throw new Error("Unverified cable at " + link.label + ".");
        }
    });
}

function verifyRoutedConfiguration(job) {
    var topology = job.request.topology;
    topology.sites.forEach(function (site) {
        var state = job.routedSites[site.name];
        if (Number(state.ethernetSwitch.getPort("FastEthernet0/24").getAdminOpMode()) !== 2) {
            throw new Error(site.switchName + " did not configure its router trunk.");
        }
        site.vlans.forEach(function (vlan) {
            var port = state.router.getPort("GigabitEthernet0/0." + vlan.id);
            if (!port || String(port.getIpAddress()) !== vlan.gateway || String(port.getSubnetMask()) !== vlan.mask) {
                throw new Error(site.routerName + " did not configure VLAN " + vlan.id + " gateway.");
            }
            vlan.pcs.forEach(function (pc) {
                var switchPort = state.ethernetSwitch.getPort(pc.switchPort);
                if (Number(switchPort.getAccessVlan()) !== vlan.id || Number(switchPort.getAdminOpMode()) !== 3) {
                    throw new Error(site.switchName + " did not assign " + pc.switchPort + " to VLAN " + vlan.id + ".");
                }
            });
        });
        var startup = state.router.getStartupFile();
        var startupText = Array.prototype.join.call(startup, "\n");
        site.routes.forEach(function (route) {
            if (startupText.indexOf("ip route " + route.network + " " + route.mask + " " + route.nextHop) < 0) {
                throw new Error(site.routerName + " did not persist its static route to " + route.network + ".");
            }
        });
    });
    topology.wanLinks.forEach(function (link) {
        var from = job.routedSites[link.from].router.getPort(link.fromPort);
        var to = job.routedSites[link.to].router.getPort(link.toPort);
        if (String(from.getIpAddress()) !== link.fromIpv4 || String(from.getSubnetMask()) !== link.mask ||
                String(to.getIpAddress()) !== link.toIpv4 || String(to.getSubnetMask()) !== link.mask) {
            throw new Error("WAN IPv4 readback differs from the requested plan.");
        }
    });
}

function advanceRoutedJob(job, now) {
    if (now >= job.routedDeadline) throw new Error("Packet Tracer did not finish routed lab configuration.");
    var complete = true;
    job.routedDevices.forEach(function (state) {
        advanceRoutedConsole(state, now);
        if (state.index < state.commands.length) complete = false;
    });
    if (complete) {
        verifyRoutedInventory(job);
        verifyRoutedConfiguration(job);
        startConnectivityChecks(job, now);
    }
}
