// Where the mountains' silhouette ends and the sky begins, across the art's 3840-wide canvas: the topmost drawn pixel
// down each column of the far mountains, the near mountains and the valley together (whichever stands highest there),
// in the art's own 4320-tall units. The sound's lines stand a little below this, so each one climbs out of the skyline
// wherever it is on the screen rather than from one flat line.
//
// Measured from the three svgs in app/(landing)/parallax by drawing each at a tenth of its size and reading down each
// column for the first pixel with any paint in it; remeasure if the mountains are ever redrawn.
export const SKYLINE = [
     716,  728,  808,  888,  904, 1008,  976,  952,  976, 1080, 1144, 1132,
    1124, 1124, 1188, 1264, 1292, 1292, 1268, 1244, 1224, 1228, 1180, 1120,
    1096, 1112, 1140, 1152, 1176, 1184, 1184, 1188, 1184, 1152, 1072,  928,
     856,  840,  844,  848,  796,  716,  700,  676,  672,  760,  688,  652,
]

// The skyline at a point across the canvas, between the samples either side of it
export function skylineAt(x: number) {
    const at = Math.min(Math.max(x / 3840, 0), 1) * SKYLINE.length - 0.5
    const first = Math.min(Math.max(Math.floor(at), 0), SKYLINE.length - 1)
    const next = Math.min(first + 1, SKYLINE.length - 1)
    return SKYLINE[first] + (SKYLINE[next] - SKYLINE[first]) * Math.min(Math.max(at - first, 0), 1)
}
