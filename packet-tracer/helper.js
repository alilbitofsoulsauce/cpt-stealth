// Packet Tracer Script Modules run in a Qt ECMAScript engine.
var jobDirectory;

var requestPath;
var readyPath;
var app;
var files;
var processId;
var pollTimer;
var lastHeartbeat = 0;
var nextDiscovery = 0;
var lastHandledId;
var lastPollError;
var activeJob;

function main() {
    app = ipc.appWindow();
    files = ipc.systemFileManager();
    try {
        processId = app.getProcessId();
    } catch (error) {
        dprint("Packet Tracer Helper could not read the process ID: " + error);
    }

    app.registerEvent("fileSaveDone", null, onSaveDone);
    app.registerEvent("fileOpened", null, onWorkspaceChanged);
    app.registerEvent("fileNewed", null, onWorkspaceChanged);
    if (!connectBridge()) {
        chooseBridgeDirectory();
    }
    pollTimer = setInterval(pollBridge, 300);
    pollBridge();
}

function connectBridge() {
    var saved = String($getData("bridgeDirectory") || "");
    var folder = normalizePath(String(app.getUserFolder() || "")).replace(/\/$/, "");
    if (saved && files.fileExists(saved + "/connection.json")) {
        setBridgeDirectory(saved);
        return true;
    }
    while (/^[A-Za-z]:\/.+\//.test(folder) || /^[A-Za-z]:\/[^/]+$/.test(folder)) {
        var candidate = folder + "/AppData/Local/PacketTracerHelper/bridge";
        if (files.fileExists(candidate + "/connection.json")) {
            setBridgeDirectory(candidate);
            return true;
        }
        folder = folder.substring(0, folder.lastIndexOf("/"));
    }
    return false;
}

function setBridgeDirectory(directory) {
    jobDirectory = normalizePath(directory).replace(/\/$/, "");
    requestPath = jobDirectory + "/request.json";
    readyPath = jobDirectory + "/ready.json";
}

function chooseBridgeDirectory() {
    var selected = files.getOpenFileName("Select the Packet Tracer Helper connection file", "", "Connection file (connection.json)");
    if (selected) {
        var path = normalizePath(selected);
        var directory = path.substring(0, path.lastIndexOf("/"));
        if (/\/PacketTracerHelper\/bridge\/connection\.json$/i.test(path) && files.fileExists(path)) {
            $putData("bridgeDirectory", directory);
            setBridgeDirectory(directory);
        }
    }
}

function cleanUp() {
    clearInterval(pollTimer);
    try {
        if (files && readyPath && files.fileExists(readyPath)) {
            var owner = readJson(readyPath);
            if (owner.pid === processId) {
                files.removeFile(readyPath);
            }
        }
    } catch (error) {
        dprint("Packet Tracer Helper could not clear its ready file: " + error);
    }
}

function normalizePath(path) {
    return path.replace(/\\/g, "/");
}

function readJson(path) {
    return JSON.parse(String(files.getFileContents(path)).replace(/^\uFEFF/, ""));
}

function updateHeartbeat(now) {
    if (now - lastHeartbeat < 2000) {
        return true;
    }
    if (!files.directoryExists(jobDirectory)) {
        return false;
    }
    if (processId && files.fileExists(readyPath) &&
            now - Number(files.getFileModificationTime(readyPath)) * 1000 < 6500) {
        var owner = readJson(readyPath);
        if (owner.pid && Number(owner.pid) !== Number(processId)) {
            return false;
        }
    }
    if (!files.writePlainTextToFile(readyPath, JSON.stringify({pid: processId}))) {
        throw new Error("Could not write ready.json. Check the bridge path and File privilege.");
    }
    lastHeartbeat = now;
    return true;
}

function pollBridge() {
    try {
        var now = Date.now();
        if (!jobDirectory) {
            if (now < nextDiscovery) return;
            nextDiscovery = now + 2000;
            if (!connectBridge()) return;
        }
        if (!updateHeartbeat(now)) {
            return;
        }
        if (activeJob) {
            advanceJob(now);
        } else if (files.fileExists(requestPath)) {
            var request = readJson(requestPath);
            if (!request || typeof request.id !== "string" ||
                    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(request.id)) {
                throw new Error("request.json must have a lowercase UUID id.");
            }
            var resultPath = jobDirectory + "/result-" + request.id + ".json";
            if (request.id === lastHandledId || files.fileExists(resultPath) ||
                    (typeof request.startBy === "number" && now > request.startBy)) {
                removeConsumedRequest(request.id);
            } else {
                activeJob = {request: request, resultPath: resultPath, checks: []};
                try {
                    buildTopology(activeJob);
                } catch (error) {
                    finishJob(false, error.message || String(error));
                }
            }
        }
        lastPollError = null;
    } catch (error) {
        var message = error.message || String(error);
        if (message !== lastPollError) {
            dprint("Packet Tracer Helper: " + message);
            lastPollError = message;
        }
    }
}

function removeConsumedRequest(id) {
    if (files.fileExists(requestPath) && readJson(requestPath).id === id &&
            !files.removeFile(requestPath)) {
        throw new Error("Could not clear the completed request.");
    }
}

function validOutputPath(path) {
    if (typeof path !== "string") {
        return false;
    }
    var parts = normalizePath(path).split("/");
    var filename = parts.pop();
    var directory = parts.join("/").toLowerCase();
    var bridge = jobDirectory.toLowerCase();
    var userDirectory = bridge.substring(0, bridge.lastIndexOf("/"));
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}\.pkt$/i.test(filename) &&
        (directory === userDirectory + "/labs" || directory === bridge + "/labs");
}

function ipv4Number(ipv4) {
    if (typeof ipv4 !== "string" || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ipv4)) {
        throw new Error("Invalid IPv4 address or mask.");
    }
    return ipv4.split(".").reduce(function (value, octet) {
        var number = Number(octet);
        if (number > 255) {
            throw new Error("IPv4 octets must be between 0 and 255.");
        }
        return value * 256 + number;
    }, 0) >>> 0;
}

function deviceNameIsValid(name) {
    return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name);
}

function switchPortName(port) {
    var match = /^FastEthernet0\/([1-9]|1\d|2[0-4])$/.exec(port);
    if (match) {
        return port;
    }
    if (typeof port === "number" && port % 1 === 0 && port >= 1 && port <= 24) {
        return "FastEthernet0/" + port;
    }
    throw new Error("Use switch ports FastEthernet0/1 through FastEthernet0/24.");
}

function validateTopology(topology) {
    if (!topology || topology.schemaVersion !== 1 || !deviceNameIsValid(topology.switchName) ||
            !Array.isArray(topology.pcs) || topology.pcs.length < 1 || topology.pcs.length > 24 ||
            !Array.isArray(topology.pings) || topology.pings.length > 24 ||
            typeof topology.subnet !== "string") {
        throw new Error("Use a version 1 topology with one named switch and 1–24 PCs.");
    }
    var subnetParts = topology.subnet.split("/");
    var subnet = ipv4Number(subnetParts[0]);
    var mask = ipv4Number(topology.mask);
    var hostMask = (~mask) >>> 0;
    if (mask === 0 || hostMask < 3 || (hostMask & (hostMask + 1)) !== 0 ||
            ((subnet & mask) >>> 0) !== subnet || subnetParts.length > 2 ||
            (subnetParts.length === 2 &&
             subnetParts[1] !== String(32 - Math.round(Math.log(hostMask + 1) / Math.LN2)))) {
        throw new Error("The subnet and IPv4 mask must describe the same network.");
    }

    var endpoints = Object.create(null);
    var addresses = Object.create(null);
    var ports = Object.create(null);
    var names = Object.create(null);
    names[topology.switchName.toLowerCase()] = true;
    topology.pcs.forEach(function (pc) {
        if (!pc || !deviceNameIsValid(pc.name) || names[pc.name.toLowerCase()]) {
            throw new Error("PC names must be unique and differ from the switch name.");
        }
        var portName = switchPortName(pc.switchPort);
        var address = ipv4Number(pc.ipv4);
        if (ports[portName] || addresses[address] ||
                ((address & mask) >>> 0) !== subnet || address === subnet ||
                address === ((subnet | hostMask) >>> 0)) {
            throw new Error("Each PC needs a unique switch port and usable subnet address.");
        }
        endpoints[pc.name] = true;
        names[pc.name.toLowerCase()] = true;
        addresses[address] = true;
        ports[portName] = true;
    });
    topology.pings.forEach(function (check) {
        if (!check || typeof check.from !== "string" || typeof check.to !== "string" ||
                !endpoints[check.from] || !endpoints[check.to] || check.from === check.to) {
            throw new Error("A ping must name two distinct PCs in this lab.");
        }
    });
}

function buildTopology(job) {
    var request = job.request;
    var topology = request.topology;
    if (!validOutputPath(request.outputPath) || files.fileExists(request.outputPath)) {
        throw new Error("Choose a new .pkt output in the Packet Tracer Helper labs directory.");
    }
    validateTopology(topology);

    var network = ipc.network();
    var workspace = app.getActiveWorkspace().getLogicalWorkspace();
    var activeFile = app.getActiveFile();
    var filename = activeFile && String(activeFile.getSavedFilename() || "");
    if (!activeFile || (filename && filename.toLowerCase() !== "untitled") ||
            network.getDeviceCount() !== 0 || network.getLinkCount() !== 0 ||
            workspace.getComponentItemsCount() !== 0 || workspace.getCanvasItemIds().length !== 0) {
        throw new Error("Open a fresh, empty Packet Tracer lab with File > New and retry.");
    }

    job.network = network;
    job.endpoints = Object.create(null);
    job.modifiedWorkspace = true;
    var switchDevice = addDevice(workspace, network, 1, ["2960-24TT", "2960"], topology.switchName, 420, 100);
    topology.pcs.forEach(function (pc, index) {
        var device = addDevice(workspace, network, 8, ["PC-PT"], pc.name,
            130 + (index % 6) * 116, 245 + Math.floor(index / 6) * 105);
        var port = device.getPort("FastEthernet0");
        port.setIpSubnetMask(pc.ipv4, topology.mask);
        if (String(port.getIpAddress()) !== pc.ipv4 || String(port.getSubnetMask()) !== topology.mask) {
            throw new Error("Could not configure IPv4 on " + pc.name + ".");
        }
        var switchPort = switchDevice.getPort(switchPortName(pc.switchPort));
        var linked = workspace.createLink(device.getName(), port.getName(),
            switchDevice.getName(), switchPort.getName(), 8100);
        if (!linked) {
            throw new Error("Packet Tracer could not connect " + pc.name + " to " + topology.switchName + ".");
        }
        job.endpoints[pc.name] = {device: device, port: port, switchPort: switchPort, ipv4: pc.ipv4};
    });

    job.checks = topology.pings.map(function (check) {
        return {from: check.from, to: check.to, ok: false};
    });
    job.phase = "links";
    job.linkDeadline = Date.now() + 3000;
}

function verifyTopology(job, now) {
    var topology = job.request.topology;
    var deviceCount = Number(job.network.getDeviceCount());
    var linkCount = Number(job.network.getLinkCount());
    var expected = Object.create(null);
    var unexpected = [];
    expected[topology.switchName] = "2960-24TT";
    topology.pcs.forEach(function (pc) { expected[pc.name] = "PC-PT"; });

    for (var index = 0; index < deviceCount; index++) {
        var device = job.network.getDeviceAt(index);
        var name = String(device.getName());
        var model = String(device.getModel());
        // Packet Tracer 9.0.1 adds this physical power device to an empty lab.
        if (model === "Power Distribution Device" && /^Power ?Distribution ?Device\d+$/.test(name)) {
            continue;
        }
        if (expected[name] === model) {
            delete expected[name];
        } else {
            unexpected.push(name + " (" + model + ")");
        }
    }
    var missing = Object.keys(expected);
    var disconnected = topology.pcs.filter(function (pc) {
        var endpoint = job.endpoints[pc.name];
        var pcLink = endpoint.port.getLink();
        var switchLink = endpoint.switchPort.getLink();
        var pcLinkId = pcLink && pcLink.getObjectUuid();
        var switchLinkId = switchLink && switchLink.getObjectUuid();
        return !pcLinkId || !switchLinkId || String(pcLinkId) !== String(switchLinkId);
    });

    if (missing.length === 0 && unexpected.length === 0 && disconnected.length === 0) {
        if (linkCount !== topology.pcs.length) {
            dprint("Packet Tracer reported " + linkCount + " network links. Verified " +
                topology.pcs.length + " requested cables directly at their endpoints.");
        }
        job.phase = "pings";
        job.pingQueue = job.checks.slice();
        job.pingAttempts = Object.create(null);
        job.nextPingAt = now + 1000;
        job.pingDeadline = now + 65000;
    } else if (now >= job.linkDeadline) {
        var names = disconnected.map(function (pc) { return pc.name; });
        throw new Error("Packet Tracer reported " + deviceCount + " devices and " + linkCount + " links. " +
            "Missing lab devices: " + (missing.join(", ") || "none") + ". " +
            "Unexpected devices: " + (unexpected.join(", ") || "none") + ". " +
            "Unverified cables: " + (names.join(", ") || "none") + ".");
    }
}

function addDevice(workspace, network, type, models, name, x, y) {
    var actualName;
    var modelIndex;
    for (modelIndex = 0; !actualName && modelIndex < models.length; modelIndex++) {
        actualName = workspace.addDevice(type, models[modelIndex], x, y);
    }
    if (!actualName) {
        throw new Error("Packet Tracer could not place " + name + " (" + models[0] + ").");
    }
    var device = network.getDevice(actualName);
    device.setName(name);
    return device;
}

function pollPings(job) {
    Object.keys(job.pingAttempts).forEach(function (source) {
        var attempt = job.pingAttempts[source];
        var output = String(attempt.terminal.getOutput());
        if (output === attempt.previousOutput) {
            return;
        }
        var header = "Ping statistics for " + attempt.destination + ":";
        var previousHeader = attempt.previousOutput.lastIndexOf(header);
        var headerIndex = output.lastIndexOf(header);
        if (headerIndex < 0 || (headerIndex === previousHeader &&
                output.substring(0, headerIndex) === attempt.previousOutput.substring(0, previousHeader))) {
            return;
        }
        var stats = /Packets:\s*Sent\s*=\s*\d+\s*,\s*Received\s*=\s*(\d+)\s*,\s*Lost\s*=\s*\d+/i
            .exec(output.substring(headerIndex + header.length));
        if (stats) {
            delete job.pingAttempts[source];
            attempt.check.ok = Number(stats[1]) > 0;
            if (!attempt.check.ok) {
                job.pingQueue.push(attempt.check);
            }
        }
    });

    // Only one command may be active in each simulated PC's command prompt.
    var queuedCount = job.pingQueue.length;
    for (var index = 0; index < queuedCount; index++) {
        var check = job.pingQueue.shift();
        if (job.pingAttempts[check.from]) {
            job.pingQueue.push(check);
        } else {
            var terminal = job.endpoints[check.from].device.getCommandLine();
            var destination = job.endpoints[check.to].ipv4;
            job.pingAttempts[check.from] = {
                check: check,
                terminal: terminal,
                destination: destination,
                previousOutput: String(terminal.getOutput())
            };
            // The address is a validated IPv4 address from a PC in this lab.
            terminal.enterCommand("ping " + destination);
        }
    }
}

function advanceJob(now) {
    var job = activeJob;
    if (job.phase === "result") {
        publishResult(job);
        return;
    }
    try {
        if (job.phase === "links") {
            verifyTopology(job, now);
        } else if (job.phase === "save" && now >= job.saveDeadline) {
            finishJob(false, "Packet Tracer did not confirm the native .pkt save.");
        } else if (job.phase === "pings") {
            var allPassed = job.checks.every(function (check) { return check.ok; });
            if (allPassed || now >= job.pingDeadline) {
                saveTopology(job);
            } else if (now >= job.nextPingAt) {
                pollPings(job);
            }
        }
    } catch (error) {
        finishJob(false, error.message || String(error));
    }
}

function saveTopology(job) {
    if (files.fileExists(job.request.outputPath)) {
        throw new Error("The output .pkt already exists. Start a new build with a different name.");
    }
    job.phase = "save";
    job.saveDeadline = Date.now() + 10000;
    app.fileSaveAsAsync(job.request.outputPath);
}

function onSaveDone(event, args) {
    var job = activeJob;
    if (!job || job.phase !== "save") {
        return;
    }
    var path = job.request.outputPath;
    if (args.success && files.fileExists(path) && files.getFileSize(path) > 0) {
        finishJob(true);
    } else if (!args.success) {
        finishJob(false, "Packet Tracer could not save the native .pkt file.");
    }
}

function onWorkspaceChanged() {
    if (activeJob && activeJob.phase !== "result") {
        finishJob(false, "The active Packet Tracer lab changed during the build.");
    }
}

function finishJob(ok, error) {
    var job = activeJob;
    job.phase = "result";
    job.result = {id: job.request.id, ok: ok, outputPath: job.request.outputPath};
    if (job.checks.length) {
        job.result.checks = job.checks;
    }
    if (error) {
        job.result.error = error;
        if (job.modifiedWorkspace) {
            job.result.error += " Use File > New before retrying.";
        }
    }
}

function publishResult(job) {
    var temporaryPath = job.resultPath + ".tmp";
    if (!files.fileExists(job.resultPath) &&
            (!files.writePlainTextToFile(temporaryPath, JSON.stringify(job.result)) ||
             !files.moveSrcFileToDestFile(temporaryPath, job.resultPath, false))) {
        throw new Error("Could not publish the build result.");
    }
    lastHandledId = job.request.id;
    activeJob = null;
    removeConsumedRequest(lastHandledId);
}
