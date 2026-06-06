// mediaManager.js — getUserMedia wrapper with 720p constraints + typed errors

const VIDEO_CONSTRAINTS = {
    width:     { ideal: 1920 },
    height:    { ideal: 1080 },
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

export async function getLocalStream({ video = true, audio = true, facingMode = null } = {}) {
    const constraints = {};
    if (video) {
        constraints.video = facingMode
            ? { ...VIDEO_CONSTRAINTS, facingMode }
            : VIDEO_CONSTRAINTS;
    }
    if (audio) constraints.audio = AUDIO_CONSTRAINTS;

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        // Force x1.0 wide-angle lens — on iPhones the OS defaults to telephoto.
        // applyConstraints({ zoom: min }) picks the widest available lens.
        if (video) {
            const track = stream.getVideoTracks()[0];
            const caps = track?.getCapabilities?.();
            if (caps?.zoom) {
                await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] })
                    .catch(() => {}); // silently ignore — older browsers don't support zoom
            }
        }

        return stream;
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
