import argparse
import base64
import glob
import json
import os
import re
from io import BytesIO

import pandas as pd
from dotenv import load_dotenv
from google.cloud import aiplatform, storage
from openai import OpenAI
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

GCP_PROJECT = os.environ.get("GCP_PROJECT_ID")
GCP_LOCATION_CLAUDE = "us-central1"
GCP_LOCATION = "global"
GCS_BUCKET = os.environ.get("GCP_BUCKET_NAME", "vetest-data-collection")
GCS_INPUT_PREFIX = "ai_batch_inputs"
GCS_OUTPUT_PREFIX = "ai_batch_outputs"


def get_base_name(filename):
    pattern = re.compile(r"^([A-Z])-([a-zA-Z_]+)-(image\d+)(?:[-_](.+))?\.jpg$")
    m = pattern.match(filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return filename


def resize_and_encode_image(image_path, resize_val):
    try:
        with Image.open(image_path) as img:
            if resize_val > 0:
                if img.mode in ("RGBA", "P"):
                    img.convert("RGB")
                img.thumbnail((resize_val, resize_val), Image.Resampling.LANCZOS)
            buffered = BytesIO()
            img.save(buffered, format="JPEG", quality=85)
            return base64.b64encode(buffered.getvalue()).decode("utf-8"), "image/jpeg"
    except Exception as e:
        print(f"Error processing image {image_path}: {e}")
        return None, None


def prepare_data(args, models_to_run):
    print("Loading data...")
    with open(PROMPTS_FILE, "r") as f:
        prompt_groups = json.load(f)
    all_files = glob.glob(CSV_PATTERN)
    if not all_files:
        raise ValueError(f"No CSV files found matching {CSV_PATTERN}")

    df = pd.concat(
        (pd.read_csv(f, on_bad_lines="warn") for f in all_files), ignore_index=True
    )

    base_prompts = {}
    for _, row in df.iterrows():
        filename = row.get("filename")
        q_type = row.get("type")
        custom_prompt = row.get("custom_prompt")
        shorthand_notes = row.get("shorthand_notes")
        
        if not all(isinstance(i, str) for i in [filename, q_type]):
            continue
            
        base_name = get_base_name(filename)
        
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
        
        if base_name not in base_prompts:
            base_prompts[base_name] = []
            
        prompt_exists = False
        for p in base_prompts[base_name]:
            if p["custom_prompt"] == custom_prompt:
                prompt_exists = True
                break
                
        if not prompt_exists:
            base_prompts[base_name].append({
                "custom_prompt": custom_prompt,
                "text": text,
                "instruction": instruction
            })

    completed_tasks = set()
    if args.missing and os.path.exists(args.answers_csv):
        answers_df = pd.read_csv(args.answers_csv)
        for _, row in answers_df.iterrows():
            filename = row["filename"]
            base_name = get_base_name(filename)
            prompts = base_prompts.get(base_name, [])
            for p in prompts:
                prompt = p["custom_prompt"]
                for model in models_to_run:
                    num_col, bool_col = f"{model}_num", f"{model}_bool"
                    if (
                        num_col in answers_df.columns and pd.notna(row.get(num_col))
                    ) or (
                        bool_col in answers_df.columns and pd.notna(row.get(bool_col))
                    ):
                        completed_tasks.add(f"{filename}|{prompt}|{model}")

    all_questions = []
    all_images = glob.glob(os.path.join(IMAGES_DIR, "*.jpg"))
    for image_path in all_images:
        filename = os.path.basename(image_path)
        base_name = get_base_name(filename)
        
        prompts = base_prompts.get(base_name, [])
        for p in prompts:
            final_prompt = f"Image ID: {filename}\n{p['text']}\n\n{p['instruction']}"
            all_questions.append(
                {
                    "filename": filename,
                    "custom_prompt": p["custom_prompt"],
                    "prompt": final_prompt,
                }
            )

    data_to_process = {model: [] for model in models_to_run}
    image_cache = {}

    for question in all_questions:
        filename, custom_prompt, prompt = (
            question["filename"],
            question["custom_prompt"],
            question["prompt"],
        )
        for model in models_to_run:
            task_key = f"{filename}|{custom_prompt}|{model}"
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
                data_to_process[model].append(
                    {
                        "custom_id": f"{filename}|{custom_prompt}",
                        "prompt": prompt,
                        "b64_data": b64_data,
                        "mime_type": mime_type,
                    }
                )

    return data_to_process


# ... (rest of the generation and submission functions remain the same)
def generate_openai_jsonl(data, output_file):
    with open(output_file, "w") as f:
        for item in data:
            f.write(
                json.dumps(
                    {
                        "custom_id": item["custom_id"],
                        "method": "POST",
                        "url": "/v1/chat/completions",
                        "body": {
                            "model": "gpt-5.4",
                            "response_format": {"type": "json_object"},
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {"type": "text", "text": item["prompt"]},
                                        {
                                            "type": "image_url",
                                            "image_url": {
                                                "url": f"data:{item['mime_type']};base64,{item['b64_data']}"
                                            },
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                )
                + "\n"
            )


def generate_vertex_jsonl(data, output_file):
    with open(output_file, "w") as f:
        for item in data:
            f.write(
                json.dumps(
                    {
                        "request": {
                            "contents": [
                                {
                                    "role": "user",
                                    "parts": [
                                        {"text": item["prompt"]},
                                        {
                                            "inlineData": {
                                                "mimeType": item["mime_type"],
                                                "data": item["b64_data"],
                                            }
                                        },
                                    ],
                                }
                            ]
                        }
                    }
                )
                + "\n"
            )


def generate_vertex_claude_jsonl(data, output_file):
    with open(output_file, "w") as f:
        for item in data:
            f.write(
                json.dumps(
                    {
                        "request": {
                            "anthropic_version": "vertex-2023-10-16",
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "image",
                                            "source": {
                                                "type": "base64",
                                                "media_type": item["mime_type"],
                                                "data": item["b64_data"],
                                            },
                                        },
                                        {"type": "text", "text": item["prompt"]},
                                    ],
                                }
                            ],
                        }
                    }
                )
                + "\n"
            )


def submit_openai_batch(file_path):
    print("Submitting to OpenAI...")
    client = OpenAI()
    batch_input_file = client.files.create(file=open(file_path, "rb"), purpose="batch")
    batch_job = client.batches.create(
        input_file_id=batch_input_file.id,
        endpoint="/v1/chat/completions",
        completion_window="24h",
    )
    print(f"OpenAI Batch submitted. Job ID: {batch_job.id}")
    return batch_job.id, batch_input_file.id


def submit_vertex_batch(local_file_path, model_name):
    print(f"Submitting {model_name} to Vertex AI...")
    storage_client = storage.Client(project=GCP_PROJECT)
    bucket = storage_client.bucket(GCS_BUCKET)
    filename = os.path.basename(local_file_path)
    gcs_input_uri = f"gs://{GCS_BUCKET}/{GCS_INPUT_PREFIX}/{filename}"
    blob = bucket.blob(f"{GCS_INPUT_PREFIX}/{filename}")
    blob.upload_from_filename(local_file_path, timeout=900)
    print(f"Uploaded {filename} to {gcs_input_uri}")
    aiplatform.init(
        project=GCP_PROJECT,
        location=GCP_LOCATION_CLAUDE if "claude" in model_name else GCP_LOCATION,
    )
    batch_job = aiplatform.BatchPredictionJob.submit(
        job_display_name=f"ve_eval_{model_name.replace('.', '_')}",
        model_name=f"publishers/google/models/{model_name}"
        if "gemini" in model_name
        else f"publishers/anthropic/models/{model_name}",
        gcs_source=[gcs_input_uri],
        gcs_destination_prefix=f"gs://{GCS_BUCKET}/{GCS_OUTPUT_PREFIX}/{model_name}/",
    )
    print("Vertex AI Batch submitted.")
    return batch_job.resource_name, gcs_input_uri


def main():
    parser = argparse.ArgumentParser(
        description="Submit batch inference jobs to AI models."
    )
    parser.add_argument(
        "--models",
        type=str,
        default="all",
        help="Comma-separated list of models to run.",
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
        default="batch_tracker.json",
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

    models_to_run = (
        [m.strip() for m in args.models.split(",")]
        if args.models != "all"
        else ["openai", "gemini", "claude", "gemini-robotics"]
    )

    data_to_process = prepare_data(args, models_to_run)

    if args.dry_run:
        print("\n--- DRY RUN REPORT ---")
        total_new = 0
        for model, data in data_to_process.items():
            if data:
                print(f"\nModel: {model} ({len(data)} new questions)")
                total_new += len(data)
                for item in data[:5]:
                    print(f"  - {item['custom_id']}: {item['prompt'][:70]}...")
        if total_new == 0:
            print("No new questions to submit for any model.")
        print("\n--- END DRY RUN ---")
        return

    if not any(data_to_process.values()):
        print("No new data to process. Exiting.")
        return

    tracker = {}
    if os.path.exists(args.tracker_file) and not args.force_resubmit:
        with open(args.tracker_file, "r") as f:
            tracker = json.load(f)

    model_map = {
        "openai": (
            "openai_input.jsonl",
            generate_openai_jsonl,
            lambda: submit_openai_batch("openai_input.jsonl"),
        ),
        "gemini": (
            "gemini_input.jsonl",
            generate_vertex_jsonl,
            lambda: submit_vertex_batch("gemini_input.jsonl", "gemini-3.1-pro-preview"),
        ),
        "gemini-robotics": (
            "gemini_robotics_input.jsonl",
            generate_vertex_jsonl,
            lambda: submit_vertex_batch(
                "gemini_robotics_input.jsonl", "gemini-robotics-er-1.6-preview"
            ),
        ),
        "claude": (
            "claude_input.jsonl",
            generate_vertex_claude_jsonl,
            lambda: submit_vertex_batch("claude_input.jsonl", "claude-opus-4-6"),
        ),
    }

    for model, (filename, gen_func, sub_func) in model_map.items():
        if model in models_to_run and data_to_process[model]:
            gen_func(data_to_process[model], filename)
            if f"{model}_job_id" not in tracker:
                try:
                    job_id, file_id_or_uri = sub_func()
                    tracker[f"{model}_job_id"] = job_id
                    tracker[f"{model}_input_file_id_or_uri"] = file_id_or_uri
                except Exception as e:
                    print(f"Failed to submit {model}: {e}")

    with open(args.tracker_file, "w") as f:
        json.dump(tracker, f, indent=2)
    print(f"All jobs submitted. Tracking IDs saved to {args.tracker_file}.")


if __name__ == "__main__":
    main()
