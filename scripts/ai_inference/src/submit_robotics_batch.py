import argparse
import base64
import glob
import json
import os
import re
from io import BytesIO

import pandas as pd
from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

# Configuration
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

UPLOADTHING_DIR = os.path.join(PROJECT_ROOT, "uploadthing")
IMAGES_DIR = os.path.join(UPLOADTHING_DIR, "images")
CSV_PATTERN = os.path.join(UPLOADTHING_DIR, "data_export-*.csv")
PROMPTS_FILE = os.path.join(UPLOADTHING_DIR, "prompt_groups.json")

MODEL_NAME = "gemini-robotics-er-1.6-preview"
MODEL_KEY = "gemini-robotics"


def resize_and_encode_image(image_path, resize_val):
    try:
        with Image.open(image_path) as img:
            if resize_val > 0:
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")
                img.thumbnail((resize_val, resize_val), Image.Resampling.LANCZOS)
            buffered = BytesIO()
            img.save(buffered, format="JPEG", quality=85)
            return base64.b64encode(buffered.getvalue()).decode("utf-8"), "image/jpeg"
    except Exception as e:
        print(f"Error processing image {image_path}: {e}")
        return None, None


def prepare_data(args):
    print("Loading data...")
    with open(PROMPTS_FILE, "r") as f:
        prompt_groups = json.load(f)
    all_files = glob.glob(CSV_PATTERN)
    if not all_files:
        raise ValueError(f"No CSV files found matching {CSV_PATTERN}")

    df = pd.concat(
        (pd.read_csv(f, on_bad_lines="warn") for f in all_files), ignore_index=True
    )

    completed_tasks = set()
    if args.missing and os.path.exists(args.answers_csv):
        answers_df = pd.read_csv(args.answers_csv)
        filename_to_prompts = (
            df.groupby("filename")["custom_prompt"].apply(list).to_dict()
        )

        for _, row in answers_df.iterrows():
            filename = row["filename"]
            prompts = filename_to_prompts.get(filename, [])
            for prompt in prompts:
                num_col, bool_col = f"{MODEL_KEY}_num", f"{MODEL_KEY}_bool"
                if (num_col in answers_df.columns and pd.notna(row.get(num_col))) or (
                    bool_col in answers_df.columns and pd.notna(row.get(bool_col))
                ):
                    completed_tasks.add(f"{filename}|{prompt}")

    all_questions = []
    for _, row in df.iterrows():
        filename, q_type, custom_prompt, shorthand_notes = (
            row.get("filename"),
            row.get("type"),
            row.get("custom_prompt"),
            row.get("shorthand_notes"),
        )
        if not all(isinstance(i, str) for i in [filename, q_type]):
            continue

        shorthand_val = (
            str(shorthand_notes).strip().lower() if pd.notna(shorthand_notes) else ""
        )
        is_boolean = shorthand_val in ["yes", "no"]
        text = str(custom_prompt)
        if len(text) <= 3:
            text = prompt_groups.get(text, f"Missing prompt for ID {text}")

        unit_match = re.match(r"^([\d.]+)\s+(.+)$", str(shorthand_notes).strip())
        unit = unit_match.group(2) if not is_boolean and unit_match else None

        instruction = "You must output valid JSON containing two keys: 'reasoning' (a short string) and 'final_answer' (a float or boolean)."
        if is_boolean:
            instruction += " The final_answer should be a boolean (true or false)."
        elif unit:
            instruction += f" The final_answer should be a float. The unit is {unit}."
        final_prompt = f"Image ID: {filename}\n{text}\n\n{instruction}"

        all_questions.append(
            {
                "filename": filename,
                "custom_prompt": custom_prompt,
                "prompt": final_prompt,
            }
        )

    data_to_process = []
    image_cache = {}

    for question in all_questions:
        filename, custom_prompt, prompt = (
            question["filename"],
            question["custom_prompt"],
            question["prompt"],
        )
        task_key = f"{filename}|{custom_prompt}"
        if task_key in completed_tasks:
            continue

        if filename not in image_cache:
            image_path = os.path.join(IMAGES_DIR, filename)
            image_cache[filename] = (
                resize_and_encode_image(image_path, args.image_resize)
                if os.path.exists(image_path)
                else (None, None)
            )

        b64_data, mime_type = image_cache[filename]
        if b64_data:
            # Format expected by Google AI Batch API (InlinedRequest)
            data_to_process.append(
                {
                    "key": task_key,
                    "request": {
                        "contents": [
                            {
                                "role": "user",
                                "parts": [
                                    {"text": prompt},
                                    {
                                        "inlineData": {
                                            "mimeType": mime_type,
                                            "data": b64_data,
                                        }
                                    },
                                ],
                            }
                        ]
                    },
                }
            )

    return data_to_process


def main():
    parser = argparse.ArgumentParser(
        description=f"Submit batch inference jobs to Google AI {MODEL_NAME} model."
    )
    parser.add_argument(
        "--image-resize",
        type=int,
        default=0,
        help="Resize images to this max dimension. 0 to disable.",
    )
    parser.add_argument(
        "--force-resubmit",
        action="store_true",
        help="Resubmit jobs even if in tracker.",
    )
    parser.add_argument(
        "--tracker-file",
        type=str,
        default=os.path.join(os.path.dirname(__file__), "robotics_batch_tracker.json"),
        help="Path to job tracker file.",
    )
    parser.add_argument(
        "--missing",
        action="store_true",
        help="Only submit questions not in the answers CSV.",
    )
    parser.add_argument(
        "--answers-csv",
        type=str,
        default=os.path.join(UPLOADTHING_DIR, "ai_answers.csv"),
        help="Path to the AI answers CSV file.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be submitted without running.",
    )
    args = parser.parse_args()

    api_key = os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key and not args.dry_run:
        print(
            "Error: GOOGLE_AI_API_KEY environment variable is not set. This is required for the Gemini API."
        )
        return

    data_to_process = prepare_data(args)

    if args.dry_run:
        print("\n--- DRY RUN REPORT ---")
        if data_to_process:
            print(f"\nModel: {MODEL_NAME} ({len(data_to_process)} new questions)")
            for item in data_to_process[:5]:
                prompt = item["request"]["contents"][0]["parts"][0]["text"]
                match = re.search(r"Image ID:\s*([^\s]+)", prompt)
                filename = match.group(1) if match else "unknown"
                print(f"  - {filename}: {prompt[:70]}...")
        else:
            print("No new questions to submit.")
        print("\n--- END DRY RUN ---")
        return

    if not data_to_process:
        print("No new data to process. Exiting.")
        return

    tracker = {}
    if os.path.exists(args.tracker_file) and not args.force_resubmit:
        with open(args.tracker_file, "r") as f:
            tracker = json.load(f)

    if f"{MODEL_KEY}_job_id" in tracker and not args.force_resubmit:
        print(
            f"A batch job is already tracked in {args.tracker_file}. Use --force-resubmit to run anyway."
        )
        return

    client = genai.Client(api_key=api_key)
    input_filename = f"{MODEL_KEY}_input.jsonl"

    with open(input_filename, "w") as f:
        for item in data_to_process:
            f.write(json.dumps(item) + "\n")

    print("Uploading input file to Google AI API...")
    try:
        # Use simple upload, file API manages the storage
        uploaded_file = client.files.upload(
            file=input_filename, config=types.UploadFileConfig(mime_type="jsonl")
        )
        tracker[f"{MODEL_KEY}_input_file_name"] = uploaded_file.name
        print(f"Uploaded successfully. File Name: {uploaded_file.name}")
    except Exception as e:
        print(f"Failed to upload input file: {e}")
        return

    print("Creating batch job...")
    try:
        # model parameter needs "models/" prefix for Gemini API usually,
        # but the create method might handle it. We provide it explicitly to be safe.
        batch_job = client.batches.create(
            model=f"models/{MODEL_NAME}",
            src=uploaded_file.name,
        )
        tracker[f"{MODEL_KEY}_job_id"] = batch_job.name
        print(f"Batch job created successfully. Job Name: {batch_job.name}")
    except Exception as e:
        print(f"Failed to create batch job: {e}")
        return

    with open(args.tracker_file, "w") as f:
        json.dump(tracker, f, indent=2)
    print(f"Tracking IDs saved to {args.tracker_file}.")


if __name__ == "__main__":
    main()
