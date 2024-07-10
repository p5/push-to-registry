"use strict";
/***************************************************************************************************
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 **************************************************************************************************/
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFullDockerImageName = exports.getFullImageName = exports.isFullImageName = exports.splitByNewline = exports.findFuseOverlayfsPath = exports.isStorageDriverOverlay = void 0;
const ini = require("ini");
const fs_1 = require("fs");
const core = require("@actions/core");
const path = require("path");
const io = require("@actions/io");
const os = require("os");
async function findStorageDriver(filePaths) {
    let storageDriver = "";
    for (const filePath of filePaths) {
        core.debug(`Checking if the storage file exists at ${filePath}`);
        if (await fileExists(filePath)) {
            core.debug(`Storage file exists at ${filePath}`);
            const fileContent = ini.parse(await fs_1.promises.readFile(filePath, "utf-8"));
            if (fileContent.storage.driver) {
                storageDriver = fileContent.storage.driver;
            }
        }
    }
    return storageDriver;
}
async function isStorageDriverOverlay() {
    let xdgConfigHome = path.join(os.homedir(), ".config");
    if (process.env.XDG_CONFIG_HOME) {
        xdgConfigHome = process.env.XDG_CONFIG_HOME;
    }
    const filePaths = [
        "/etc/containers/storage.conf",
        path.join(xdgConfigHome, "containers/storage.conf"),
    ];
    const storageDriver = await findStorageDriver(filePaths);
    return (storageDriver === "overlay");
}
exports.isStorageDriverOverlay = isStorageDriverOverlay;
async function fileExists(filePath) {
    try {
        await fs_1.promises.access(filePath);
        return true;
    }
    catch (err) {
        return false;
    }
}
async function findFuseOverlayfsPath() {
    let fuseOverlayfsPath;
    try {
        fuseOverlayfsPath = await io.which("fuse-overlayfs");
    }
    catch (err) {
        if (err instanceof Error) {
            core.debug(err.message);
        }
    }
    return fuseOverlayfsPath;
}
exports.findFuseOverlayfsPath = findFuseOverlayfsPath;
function splitByNewline(s) {
    return s.split(/\r?\n/);
}
exports.splitByNewline = splitByNewline;
function isFullImageName(image) {
    return image.indexOf(":") > 0;
}
exports.isFullImageName = isFullImageName;
function getFullImageName(image, tag) {
    if (isFullImageName(tag)) {
        return tag;
    }
    return `${image}:${tag}`;
}
exports.getFullImageName = getFullImageName;
const DOCKER_IO = `docker.io`;
const DOCKER_IO_NAMESPACED = DOCKER_IO + `/library`;
function getFullDockerImageName(image) {
    switch (image.split("/").length) {
        case 1:
            return `${DOCKER_IO_NAMESPACED}/${image}`;
        case 2:
            if (image.includes("amazonaws.com"))
                return image;
            return `${DOCKER_IO}/${image}`;
        default:
            return image;
    }
}
exports.getFullDockerImageName = getFullDockerImageName;
//# sourceMappingURL=util.js.map