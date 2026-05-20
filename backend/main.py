import asyncio
import websockets
import time
from faster_whisper import WhisperModel
from openai import OpenAI
API_KEY=""

model = WhisperModel(
    "base",
    device="cpu",
    compute_type="int8"
)
client = OpenAI(api_key=API_KEY)

async def handler(websocket):

    audio_buffer = bytearray()

    last_transcription = time.time()

    slice_counter = 0

    async for message in websocket:

        audio_buffer.extend(message)

        with open("temp.webm", "wb") as f:
            f.write(audio_buffer)

        if time.time() - last_transcription > 5:

            segments, info = model.transcribe("temp.webm")
            print(info.language)

            
            # segments[:slice_counter]
            # for segment in segments:
            #     print(segment)
            #     slice_counter += 1
            
            segments, info = model.transcribe("temp.webm")

            segments = list(segments)
            current_text = ""
            new_segments = segments[slice_counter:]
            for segment in new_segments:
                # print(segment.text)
                slice_counter += 1
                current_text += segment.text
            response = client.chat.completions.create(
            model="gpt-4.1-mini",

            messages=[
                {
                    "role": "system",
                    "content": "You are a medical interpreter. Translate naturally and clearly. If the text is in English translate to Spanish, if it's in Spanish, translate to English"
                },

                {
                    "role": "user",
                    "content": current_text
                }
            ]
        )
            translated = response.choices[0].message.content
            print(translated)


            last_transcription = time.time()

async def main():

    async with websockets.serve(
        handler,
        "localhost",
        8765
    ):

        print("WebSocket server running...")

        await asyncio.Future()


asyncio.run(main())