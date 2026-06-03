// mediaManager.js — getUserMedia wrapper with 720p constraints + typed errors

const VIDEO_CONSTRAINTS = {
    width:  { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
};
const AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
};

export class MediaError extends Error {
    // type: 'permission-denied' | 'not-found' | 'in-use' | 'unknown'
    constructor(type, message) {
        super(message);
        this.name = 'MediaError';
        this.type = type;
    }
}

export async function getLocalStream({ video = true, audio = true } = {}) {
    const constraints = {};
    if (video) constraints.video = VIDEO_CONSTRAINTS;
    if (audio) constraints.audio = AUDIO_CONSTRAINTS;

    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            throw new MediaError('permission-denied',
                'Camera/microphone access was denied. Allow access in your browser settings and try again.');
        }
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            throw new MediaError('not-found',
                'No camera or microphone found. Connect a device and try again.');
        }
        if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            throw new MediaError('in-use',
                'Camera or microphone is in use by another application. Close it and try again.');
        }
        throw new MediaError('unknown', `Could not access media: ${err.message}`);
    }
}

export function stopStream(stream) {
    if (stream) stream.getTracks().forEach(t => t.stop());
}
