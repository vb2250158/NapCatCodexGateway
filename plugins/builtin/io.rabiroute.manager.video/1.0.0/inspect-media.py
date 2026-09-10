"""Inspect bounded local media. Never accept a URL or decode unbounded frames."""
import json
import sys
import av

file, kind = sys.argv[1:]
formats = {"image": "png_pipe", "video": "mov", "audio": "wav"}
media_format = formats[kind]

def open_media():
    # Uploaded bytes cannot select a playlist demuxer or a network protocol.
    return av.open(file, format=media_format, options={"protocol_whitelist": "file", "enable_drefs": "0"})

def check_audio(container):
    stream = container.streams.audio[0]
    assert 0 < stream.channels <= 2 and 0 < stream.sample_rate <= 96000
    count = 0
    for frame in container.decode(stream):
        count += frame.samples
        assert count <= stream.sample_rate * 15
    assert count > 0
    return count / stream.sample_rate

with open_media() as container:
    if kind == "image":
        stream = container.streams.video[0]
        assert stream.codec_context.name == "png"
        assert 0 < stream.width <= 4096 and 0 < stream.height <= 4096
        next(container.decode(stream))
        result = dict(width=stream.width, height=stream.height)
    elif kind == "video":
        assert len(container.streams.video) == 1 and len(container.streams.audio) <= 1
        stream = container.streams.video[0]
        assert stream.codec_context.name == "h264"
        assert 0 < stream.width <= 1920 and 0 < stream.height <= 1920
        assert stream.width * stream.height <= 1920 * 1080
        assert stream.average_rate == 24
        count = 0
        previous = None
        for frame in container.decode(stream):
            assert frame.pts is not None
            timestamp = frame.pts * frame.time_base
            if previous is not None:
                assert abs(float(timestamp - previous) - 1 / 24) < 0.0001
            previous = timestamp
            count += 1
            assert count <= 360
        assert 48 <= count <= 360
        result = dict(width=stream.width, height=stream.height, duration=count / 24, fps=24, hasAudio=bool(container.streams.audio))
        if result['hasAudio']:
            with open_media() as audio_container:
                check_audio(audio_container)
    else:
        assert kind == "audio" and container.format.name == "wav"
        result = dict(duration=check_audio(container))
print(json.dumps(result))
