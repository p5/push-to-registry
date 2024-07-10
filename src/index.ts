import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    isStorageDriverOverlay, findFuseOverlayfsPath,
    splitByNewline,
    isFullImageName, getFullImageName,
    getFullDockerImageName,
} from "./util";
import { Inputs, Outputs } from "./generated/inputs-outputs";

interface ExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface ImageStorageCheckResult {
    readonly foundTags: string[];
    readonly missingTags: string[];
}

let podmanPath: string | undefined;

// boolean value to check if pushed image is from Docker image storage
let isImageFromDocker = false;
let sourceImages: string[];
let destinationImages: string[];
let dockerPodmanRoot: string;
let dockerPodmanOpts: string[];

async function getPodmanPath(): Promise<string> {
    if (podmanPath == null) {
        podmanPath = await io.which("podman", true);
        await execute(podmanPath, [ "version" ], { group: true });
    }

    return podmanPath;
}

async function run(): Promise<void> {
    const DEFAULT_TAG = "latest";
    const image = core.getInput(Inputs.IMAGE);
    const tags = core.getInput(Inputs.TAGS);

    const tagsList = getTagsList(tags, DEFAULT_TAG);

    const { normalizedTagsList, isNormalized } = normalizeTags(tagsList);
    const normalizedImage = image.toLowerCase();

    if (isNormalized || image !== normalizedImage) {
        core.warning(`Reference to image and/or tag must be lowercase.`
        + ` Reference has been converted to be compliant with standard.`);
    }

    const registry = core.getInput(Inputs.REGISTRY);
    const username = core.getInput(Inputs.USERNAME);
    const password = core.getInput(Inputs.PASSWORD);
    const tlsVerify = core.getInput(Inputs.TLS_VERIFY);
    const digestFileInput = core.getInput(Inputs.DIGESTFILE);

    const isFullImageNameTag = isFullImageName(normalizedTagsList[0]);
    validateTags(normalizedTagsList, isFullImageNameTag);

    let sourceImages: string[];
    let destinationImages: string[];
    if (!isFullImageNameTag) {
        if (!normalizedImage) {
            throw new Error(`Input "${Inputs.IMAGE}" must be provided when using non full name tags`);
        }
        if (!registry) {
            throw new Error(`Input "${Inputs.REGISTRY}" must be provided when using non full name tags`);
        }

        ({ sourceImages, destinationImages } = processImageAndRegistryPaths(normalizedImage, registry, normalizedTagsList));
    } else {
        if (normalizedImage) {
            core.warning(`Input "${Inputs.IMAGE}" is ignored when using full name tags`);
        }
        if (registry) {
            core.warning(`Input "${Inputs.REGISTRY}" is ignored when using full name tags`);
        }

        sourceImages = normalizedTagsList;
        destinationImages = normalizedTagsList;
    }

    const compressionFormatsRaw = core.getInput(Inputs.COMPRESSION_FORMATS);
    const compressionFormats = splitByNewline(compressionFormatsRaw);

    if (compressionFormats.length > 0) {
        core.info(`Compression formats: ${compressionFormats.join(", ")}`);
    }

    // If a single compression format, continue.  Otherwise we need to:
    // 1. Push images to the registry with the <image>-<format> tag
    // 2. Create a manifest list called <image>
    // 3. Add the <image>-<format> tags to the manifest list
    // 4. Push the manifest list to the registry
    // 5. Exit out of the action

    let isManagedManifest = false;
    if (compressionFormats.length > 1) {
        core.info(`Multiple compression formats detected`);
        core.info(`Pushing images to the registry with the <image>-<format> tag`);

        const manifestListName = sourceImages[0];
        const manifestListImages = [];

        for (const format of compressionFormats) {
            const formatTag = `${sourceImages[0]}-${format}`;
            const formatImage = getFullImageName(sourceImages[0], formatTag);
            core.info(`Pushing image ${formatImage}`);
            await execute(await getPodmanPath(), [
                "--compression-format " + format,
                "push",
                sourceImages[0],
                formatImage,
            ]);
            manifestListImages.push({
                format,
                image: formatImage,
            });
        }

        core.info(`Creating manifest list ${manifestListName}`);
        await execute(await getPodmanPath(), [
            "manifest", "create", manifestListName,
        ]);

        // If format starts with "zstd", we need to add an annotation to the manifest list entry
        for (const { format, image } of manifestListImages) {
            core.info(`Adding ${image} to manifest list ${manifestListName} with format ${format}`);
            const annotation = format.startsWith("zstd") ? `--annotation=io.github.containers.compression.zstd=true` : "";
            await execute(await getPodmanPath(), [
                "manifest", "add", manifestListName, image, annotation,
            ]);
        }

        isManagedManifest = true;
    }


    const inputExtraArgsStr = core.getInput(Inputs.EXTRA_ARGS);
    const podmanExtraArgs = parsePodmanExtraArgs(inputExtraArgsStr);

    const isManifest = await checkIfManifestsExists();
    let isImageFromDocker = false;

    if (!isManifest) {
        const podmanImageStorageCheckResult: ImageStorageCheckResult = await checkImageInPodman();

        const podmanFoundTags: string[] = podmanImageStorageCheckResult.foundTags;
        const podmanMissingTags: string[] = podmanImageStorageCheckResult.missingTags;

        if (podmanFoundTags.length > 0) {
            core.info(`Tag${podmanFoundTags.length !== 1 ? "s" : ""} "${podmanFoundTags.join(", ")}" `
            + `found in Podman image storage`);
        }

        if (podmanMissingTags.length > 0 && podmanFoundTags.length > 0) {
            core.warning(`Tag${podmanMissingTags.length !== 1 ? "s" : ""} "${podmanMissingTags.join(", ")}" `
            + `not found in Podman image storage`);
        }

        const dockerImageStorageCheckResult: ImageStorageCheckResult = await pullImageFromDocker();

        const dockerFoundTags: string[] = dockerImageStorageCheckResult.foundTags;
        const dockerMissingTags: string[] = dockerImageStorageCheckResult.missingTags;

        if (dockerFoundTags.length > 0) {
            core.info(`Tag${dockerFoundTags.length !== 1 ? "s" : ""} "${dockerFoundTags.join(", ")}" `
            + `found in Docker image storage`);
        }

        if (dockerMissingTags.length > 0 && dockerFoundTags.length > 0) {
            core.warning(`Tag${dockerMissingTags.length !== 1 ? "s" : ""} "${dockerMissingTags.join(", ")}" `
            + `not found in Docker image storage`);
        }

        if (podmanMissingTags.length > 0 && dockerMissingTags.length > 0) {
            throw new Error(
                `❌ All tags were not found in either Podman image storage, or Docker image storage. `
                + `Tag${podmanMissingTags.length !== 1 ? "s" : ""} "${podmanMissingTags.join(", ")}" `
                + `not found in Podman image storage, and tag${dockerMissingTags.length !== 1 ? "s" : ""} `
                + `"${dockerMissingTags.join(", ")}" not found in Docker image storage.`
            );
        }

        const allTagsinPodman: boolean = podmanFoundTags.length === normalizedTagsList.length;
        const allTagsinDocker: boolean = dockerFoundTags.length === normalizedTagsList.length;

        if (allTagsinPodman && allTagsinDocker) {
            const isPodmanImageLatest = await isPodmanLocalImageLatest();
            if (!isPodmanImageLatest) {
                core.warning(
                    `The version of "${sourceImages[0]}" in the Docker image storage is more recent `
                        + `than the version in the Podman image storage. The image(s) from the Docker image storage `
                        + `will be pushed.`
                );
                isImageFromDocker = true;
            } else {
                core.warning(
                    `The version of "${sourceImages[0]}" in the Podman image storage is more recent `
                        + `than the version in the Docker image storage. The image(s) from the Podman image `
                        + `storage will be pushed.`
                );
            }
        } else if (allTagsinDocker) {
            core.info(
                `Tag "${sourceImages[0]}" was found in the Docker image storage, but not in the Podman `
                    + `image storage. The image(s) will be pulled into Podman image storage, pushed, and then `
                    + `removed from the Podman image storage.`
            );
            isImageFromDocker = true;
        } else {
            core.info(
                `Tag "${sourceImages[0]}" was found in the Podman image storage, but not in the Docker `
                    + `image storage. The image(s) will be pushed from Podman image storage.`
            );
        }
    }

    core.info(getPushMessage(sourceImages, destinationImages, username));

    const creds = validateCredentials(username, password);

    let digestFile = digestFileInput;
    if (!digestFile) {
        digestFile = `${sourceImages[0].replace(
            /[/\\/?%*:|"<>]/g,
            "-",
        )}_digest.txt`;
    }

    await pushImages(
        sourceImages, 
        destinationImages, 
        isImageFromDocker, 
        isManifest, 
        !isManagedManifest,
        podmanExtraArgs, 
        tlsVerify, 
        creds, 
        digestFile
    );
}

async function pullImageFromDocker(): Promise<ImageStorageCheckResult> {
    core.info(`🔍 Checking if "${sourceImages.join(", ")}" present in the local Docker image storage`);
    const foundTags: string[] = [];
    const missingTags: string[] = [];
    try {
        for (const imageWithTag of sourceImages) {
            const commandResult: ExecResult = await execute(
                await getPodmanPath(),
                [ ...dockerPodmanOpts, "pull", `docker-daemon:${imageWithTag}` ],
                { ignoreReturnCode: true, failOnStdErr: false, group: true }
            );
            if (commandResult.exitCode === 0) {
                foundTags.push(imageWithTag);
            }
            else {
                missingTags.push(imageWithTag);
            }
        }
    }
    catch (err) {
        if (err instanceof Error) {
            core.debug(err.message);
        }
    }

    return {
        foundTags,
        missingTags,
    };
}

async function checkImageInPodman(): Promise<ImageStorageCheckResult> {
    // check if images exist in Podman's storage
    core.info(`🔍 Checking if "${sourceImages.join(", ")}" present in the local Podman image storage`);
    const foundTags: string[] = [];
    const missingTags: string[] = [];
    try {
        for (const imageWithTag of sourceImages) {
            const commandResult: ExecResult = await execute(
                await getPodmanPath(),
                [ "image", "exists", imageWithTag ],
                { ignoreReturnCode: true }
            );
            if (commandResult.exitCode === 0) {
                foundTags.push(imageWithTag);
            }
            else {
                missingTags.push(imageWithTag);
            }
        }
    }
    catch (err) {
        if (err instanceof Error) {
            core.debug(err.message);
        }
    }

    return {
        foundTags,
        missingTags,
    };
}

async function isPodmanLocalImageLatest(): Promise<boolean> {
    // checking for only one tag as creation time will be
    // same for all the tags present
    const imageWithTag = sourceImages[0];

    // get creation time of the image present in the Podman image storage
    const podmanLocalImageTimeStamp = await execute(await getPodmanPath(), [
        "image",
        "inspect",
        imageWithTag,
        "--format",
        "{{.Created}}",
    ]);

    // get creation time of the image pulled from the Docker image storage
    // appending 'docker.io/library' infront of image name as pulled image name
    // from Docker image storage starts with the 'docker.io/library'
    const pulledImageCreationTimeStamp = await execute(await getPodmanPath(), [
        ...dockerPodmanOpts,
        "image",
        "inspect",
        getFullDockerImageName(imageWithTag),
        "--format",
        "{{.Created}}",
    ]);

    const podmanImageTime = new Date(podmanLocalImageTimeStamp.stdout).getTime();

    const dockerImageTime = new Date(pulledImageCreationTimeStamp.stdout).getTime();

    return podmanImageTime > dockerImageTime;
}

async function createDockerPodmanImageStroage(): Promise<void> {
    core.info(`Creating temporary Podman image storage for pulling from Docker daemon`);
    dockerPodmanRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "podman-from-docker-"));

    dockerPodmanOpts = [ "--root", dockerPodmanRoot ];

    if (await isStorageDriverOverlay()) {
        const fuseOverlayfsPath = await findFuseOverlayfsPath();
        if (fuseOverlayfsPath) {
            core.info(`Overriding storage mount_program with "fuse-overlayfs" in environment`);
            dockerPodmanOpts.push("--storage-opt");
            dockerPodmanOpts.push(`overlay.mount_program=${fuseOverlayfsPath}`);
        }
        else {
            core.warning(`"fuse-overlayfs" is not found. Install it before running this action. `
            + `For more detail see https://github.com/redhat-actions/buildah-build/issues/45`);
        }
    }
    else {
        core.info("Storage driver is not 'overlay', so not overriding storage configuration");
    }
}

async function removeDockerPodmanImageStroage(): Promise<void> {
    if (dockerPodmanRoot) {
        try {
            core.info(`Removing temporary Podman image storage for pulling from Docker daemon`);
            await execute(
                await getPodmanPath(),
                [ ...dockerPodmanOpts, "rmi", "-a", "-f" ]
            );
            await fs.promises.rmdir(dockerPodmanRoot, { recursive: true });
        }
        catch (err) {
            core.warning(`Failed to remove podman image stroage ${dockerPodmanRoot}: ${err}`);
        }
    }
}

async function checkIfManifestsExists(): Promise<boolean> {
    const foundManifests = [];
    const missingManifests = [];
    // check if manifest exist in Podman's storage
    core.info(`🔍 Checking if the given image is manifest or not.`);
    for (const manifest of sourceImages) {
        const commandResult: ExecResult = await execute(
            await getPodmanPath(),
            [ "manifest", "exists", manifest ],
            { ignoreReturnCode: true, group: true }
        );
        if (commandResult.exitCode === 0) {
            foundManifests.push(manifest);
        }
        else {
            missingManifests.push(manifest);
        }
    }

    if (foundManifests.length > 0) {
        core.info(`Image${foundManifests.length !== 1 ? "s" : ""} "${foundManifests.join(", ")}" `
            + `${foundManifests.length !== 1 ? "are manifests" : "is a manifest"}.`);
    }

    if (foundManifests.length > 0 && missingManifests.length > 0) {
        throw new Error(`Manifest${missingManifests.length !== 1 ? "s" : ""} "${missingManifests.join(", ")}" `
            + `not found in the Podman image storage. Make sure that all the provided images are either `
            + `manifests or container images.`);
    }

    return foundManifests.length === sourceImages.length;
}

function getTagsList(tags: string, defaultTag: string): string[] {
    const tagsList = tags.trim().split(/\s+/);
    if (tagsList.length === 0) {
        core.info(`Input "${Inputs.TAGS}" is not provided, using default tag "${defaultTag}"`);
        tagsList.push(defaultTag);
    }
    return tagsList;
}

function normalizeTags(tagsList: string[]): { normalizedTagsList: string[], isNormalized: boolean } {
    const normalizedTagsList: string[] = [];
    let isNormalized = false;
    for (const tag of tagsList) {
        normalizedTagsList.push(tag.toLowerCase());
        if (tag.toLowerCase() !== tag) {
            isNormalized = true;
        }
    }
    return { normalizedTagsList, isNormalized };
}

function validateTags(tagsList: string[], isFullImageNameTag: boolean): void {
    if (tagsList.some((tag) => isFullImageName(tag) !== isFullImageNameTag)) {
        throw new Error(`Input "${Inputs.TAGS}" cannot have a mix of full name and non full name tags`);
    }
}

function processImageAndRegistryPaths(
    normalizedImage: string, 
    registry: string, 
    tagsList: string[]
): { sourceImages: string[], destinationImages: string[] } {
    const normalizedRegistry = registry.toLowerCase();
    const registryWithoutTrailingSlash = normalizedRegistry.replace(/\/$/, "");
    const registryPath = `${registryWithoutTrailingSlash}/${normalizedImage}`;
    core.info(`Combining image name "${normalizedImage}" and registry "${registry}" `
        + `to form registry path "${registryPath}"`);
    if (normalizedImage.indexOf("/") > -1 && registry.indexOf("/") > -1) {
        core.warning(`"${registryPath}" does not seem to be a typical registry path. `
        + `Select few registries support paths containing more than two slashes. `
        + `Refer to the Inputs section of the readme for naming image and registry.`);
    }

    const sourceImages = tagsList.map((tag) => getFullImageName(normalizedImage, tag));
    const destinationImages = tagsList.map((tag) => getFullImageName(registryPath, tag));

    return { sourceImages, destinationImages };
}

function parsePodmanExtraArgs(inputExtraArgsStr: string): string[] {
    const lines = splitByNewline(inputExtraArgsStr);
    return lines.flatMap((line) => line.split(" ")).map((arg) => arg.trim());
}

function getPushMessage(sourceImages: string[], destinationImages: string[], username?: string): string {
    let pushMsg = `⏳ Pushing "${sourceImages.join(", ")}" to "${destinationImages.join(", ")}" respectively`;
    if (username) {
        pushMsg += ` as "${username}"`;
    }
    return pushMsg;
}

function validateCredentials(username?: string, password?: string): string {
    let creds = "";
    if (username && !password) {
        core.warning("Username is provided, but password is missing");
    } else if (!username && password) {
        core.warning("Password is provided, but username is missing");
    } else if (username && password) {
        creds = `${username}:${password}`;
    }
    return creds;
}

async function pushImages(
    sourceImages: string[], 
    destinationImages: string[], 
    isImageFromDocker: boolean, 
    isManifest: boolean, 
    manifestPushAll: boolean,
    podmanExtraArgs: string[], 
    tlsVerify: string, 
    creds: string, 
    digestFile: string
): Promise<void> {
    const registryPathList: string[] = [];

    for (let i = 0; i < destinationImages.length; i++) {
        const args = [];
        if (isImageFromDocker) {
            args.push(...dockerPodmanOpts);
        }
        if (isManifest) {
            args.push("manifest");
        }
        args.push(...[
            "push",
            "--quiet",
            "--digestfile",
            digestFile,
            isImageFromDocker ? getFullDockerImageName(sourceImages[i]) : sourceImages[i],
            destinationImages[i],
        ]);
        if (isManifest) {
            args.push(`--all=${manifestPushAll ? "true" : "false"}`);
        }
        if (podmanExtraArgs.length > 0) {
            args.push(...podmanExtraArgs);
        }
        if (tlsVerify) {
            args.push(`--tls-verify=${tlsVerify}`);
        }
        if (creds) {
            args.push(`--creds=${creds}`);
        }

        await execute(await getPodmanPath(), args);
        core.info(`✅ Successfully pushed "${sourceImages[i]}" to "${destinationImages[i]}"`);

        registryPathList.push(destinationImages[i]);

        try {
            const digest = (await fs.promises.readFile(digestFile)).toString();
            core.info(digest);
            core.setOutput(Outputs.DIGEST, digest);
        } catch (err) {
            core.warning(`Failed to read digest file "${digestFile}": ${err}`);
        }
    }

    core.setOutput(Outputs.REGISTRY_PATH, registryPathList[0]);
    core.setOutput(Outputs.REGISTRY_PATHS, JSON.stringify(registryPathList));
}

async function execute(
    executable: string,
    args: string[],
    execOptions: exec.ExecOptions & { group?: boolean } = {},
): Promise<ExecResult> {
    let stdout = "";
    let stderr = "";

    const finalExecOptions = { ...execOptions };
    finalExecOptions.ignoreReturnCode = true; // the return code is processed below

    finalExecOptions.listeners = {
        stdline: (line): void => {
            stdout += `${line}\n`;
        },
        errline: (line): void => {
            stderr += `${line}\n`;
        },
    };

    if (execOptions.group) {
        const groupName = [ executable, ...args ].join(" ");
        core.startGroup(groupName);
    }

    try {
        const exitCode = await exec.exec(executable, args, finalExecOptions);

        if (execOptions.ignoreReturnCode !== true && exitCode !== 0) {
            // Throwing the stderr as part of the Error makes the stderr show up in the action outline,
            // which saves some clicking when debugging.
            let error = `${path.basename(executable)} exited with code ${exitCode}`;
            if (stderr) {
                error += `\n${stderr}`;
            }
            throw new Error(error);
        }

        return {
            exitCode,
            stdout,
            stderr,
        };
    }

    finally {
        if (execOptions.group) {
            core.endGroup();
        }
    }
}

async function main(): Promise<void> {
    try {
        await createDockerPodmanImageStroage();
        await run();
    }
    finally {
        await removeDockerPodmanImageStroage();
    }
}

main()
    .catch((err) => {
        core.setFailed(err.message);
    });
