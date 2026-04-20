import argparse
import json
import os
import re

import pandas as pd
from dotenv import load_dotenv
from google.cloud import aiplatform, storage
from openai import OpenAI

# Configuration
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

GCP_PROJECT = os.environ.get("GCP_PROJECT_ID")
GCP_LOCATION_CLAUDE = "us-central1"
GCP_LOCATION = "global"
GCS_BUCKET = os.environ.get("GCP_BUCKET_NAME", "vetest-data-collection")


def extract_filename_from_prompt(prompt_text):
    match = re.search(r"Image ID:\s*([^\s]+)", prompt_text)
    return match.group(1) if match else None


def parse_json_response(text):
    try:
        clean_text = text.strip()
        start, end = clean_text.find("{"), clean_text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(clean_text[start : end + 1])
    except json.JSONDecodeError:
        match = re.search(
            r'"final_answer"\s*:\s*([\d.]+|true|false)', text, re.IGNORECASE
        )
        if match:
            val_str = match.group(1).lower()
            if val_str == "true":
                return {"final_answer": True}
            if val_str == "false":
                return {"final_answer": False}
            return {"final_answer": float(val_str)}
    return {}


def process_results(filename, answer_text, model_key):
    if not (filename and answer_text):
        return None

    parsed = parse_json_response(answer_text)
    final_ans = parsed.get("final_answer")
    reasoning = parsed.get("reasoning")

    processed_record = {"filename": filename}
    if isinstance(final_ans, bool):
        processed_record.update(
            {f"{model_key}_num": None, f"{model_key}_bool": final_ans}
        )
    elif isinstance(final_ans, (int, float)):
        processed_record.update(
            {f"{model_key}_num": final_ans, f"{model_key}_bool": None}
        )

    if reasoning:
        processed_record[f"{model_key}_reasoning"] = reasoning

    return processed_record


def save_bulk_raw_output(data_list, model_key, base_dir):
    os.makedirs(base_dir, exist_ok=True)
    filepath = os.path.join(base_dir, f"{model_key}_raw_output.json")
    with open(filepath, "w") as f:
        json.dump(data_list, f, indent=2)
    print(f"Saved raw output for {model_key} to {filepath}")


def download_vertex_outputs(job_id, model_key, args):
    print(f"Checking Vertex AI Job: {job_id}")
    aiplatform.init(
        project=GCP_PROJECT,
        location=GCP_LOCATION_CLAUDE if "claude" in model_key else GCP_LOCATION,
    )
    job = aiplatform.BatchPredictionJob(job_id)

    if job.state.name in ["JOB_STATE_RUNNING", "JOB_STATE_PENDING"]:
        print(f"{model_key} is still running.")
        return None
    if job.state.name != "JOB_STATE_SUCCEEDED":
        print(f"{model_key} failed or was cancelled. State: {job.state.name}")
        return []

    print(f"{model_key} completed. Downloading results...")
    storage_client = storage.Client(project=GCP_PROJECT)
    bucket = storage_client.bucket(GCS_BUCKET)
    prefix = job.output_info.gcs_output_directory.replace(f"gs://{GCS_BUCKET}/", "")

    results, raw_outputs = [], []
    for blob in bucket.list_blobs(prefix=prefix):
        if blob.name.endswith(".jsonl"):
            content = blob.download_as_string().decode("utf-8")
            for line in content.split("\n"):
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    raw_outputs.append(data)
                    req, resp = data.get("request", {}), data.get("response", {})

                    prompt_text = (
                        req.get("contents", [{}])[0]
                        .get("parts", [{}])[0]
                        .get("text", "")
                        if "gemini" in model_key
                        else req.get("messages", [{}])[0]
                        .get("content", [{}])[1]
                        .get("text", "")
                    )
                    filename = extract_filename_from_prompt(prompt_text)

                    answer_text = (
                        resp.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [{}])[0]
                        .get("text", "")
                        if "gemini" in model_key
                        else resp.get("content", [{}])[0].get("text", "")
                    )

                    res = process_results(filename, answer_text, model_key)
                    if res:
                        results.append(res)
                except Exception as e:
                    print(f"Error parsing line for {model_key}: {e}")

    if args.save_raw_output:
        save_bulk_raw_output(raw_outputs, model_key, args.raw_output_dir)
    return results


def download_openai_outputs(batch_id, args):
    print(f"Checking OpenAI Batch: {batch_id}")
    client = OpenAI()
    batch = client.batches.retrieve(batch_id)

    if batch.status in ["validating", "in_progress", "finalizing"]:
        return None
    if batch.status != "completed":
        print(f"OpenAI batch failed. Status: {batch.status}")
        return []

    print("OpenAI completed. Downloading...")
    if not batch.output_file_id:
        return []

    content = client.files.content(batch.output_file_id).text
    results, raw_outputs = [], []
    for line in content.split("\n"):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
            raw_outputs.append(data)
            custom_id = data.get("custom_id", "")
            filename = custom_id.split("|", 1)[0]
            answer_text = (
                data.get("response", {})
                .get("body", {})
                .get("choices", [{}])[0]
                .get("message", {})
                .get("content")
            )
            res = process_results(filename, answer_text, "openai")
            if res:
                results.append(res)
        except Exception as e:
            print(f"Error parsing OpenAI line: {e}")

    if args.save_raw_output:
        save_bulk_raw_output(raw_outputs, "openai", args.raw_output_dir)
    return results


def cleanup(tracker):
    # ... (cleanup function remains the same)
    pass


def main():
    parser = argparse.ArgumentParser(
        description="Download and process batch inference results."
    )
    parser.add_argument(
        "--tracker-file",
        type=str,
        default="batch_tracker.json",
        help="Path to job tracker file.",
    )
    parser.add_argument(
        "--output-csv",
        type=str,
        default=os.path.join(PROJECT_ROOT, "uploadthing", "ai_answers.csv"),
        help="Path to save the final CSV.",
    )
    parser.add_argument(
        "--cleanup", action="store_true", help="Delete batch files from cloud storage."
    )
    parser.add_argument(
        "--save-raw-output", action="store_true", help="Save the full raw JSON output."
    )
    parser.add_argument(
        "--raw-output-dir",
        type=str,
        default="ai_raw_outputs",
        help="Directory to save raw outputs.",
    )
    parser.add_argument(
        "--update", action="store_true", help="Update existing ai_answers.csv."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be changed without writing.",
    )
    args = parser.parse_args()

    if not os.path.exists(args.tracker_file):
        print(f"Tracker file not found at {args.tracker_file}.")
        return

    with open(args.tracker_file, "r") as f:
        tracker = json.load(f)

    all_results = {}
    jobs_done = True

    model_map = {
        "openai": (download_openai_outputs, tracker.get("openai_job_id")),
        "gemini": (download_vertex_outputs, tracker.get("gemini_job_id")),
        "claude": (download_vertex_outputs, tracker.get("claude_job_id")),
        "gemini-robotics": (
            download_vertex_outputs,
            tracker.get("gemini_robotics_job_id"),
        ),
    }

    for model_key, (func, job_id) in model_map.items():
        if job_id:
            data = (
                func(job_id, args)
                if "openai" in func.__name__
                else func(job_id, model_key, args)
            )
            if data is None:
                jobs_done = False
            elif data:
                for item in data:
                    fname = item["filename"]
                    if fname not in all_results:
                        all_results[fname] = {}
                    all_results[fname].update(item)

    if not jobs_done:
        print("Not all jobs are finished. Please wait and run the script again.")
        return

    if not all_results:
        print("No results parsed from any model.")
        return

    new_results_df = pd.DataFrame(list(all_results.values())).set_index("filename")

    existing_df = pd.DataFrame()
    if args.update and os.path.exists(args.output_csv):
        print(f"Updating existing CSV at {args.output_csv}")
        existing_df = pd.read_csv(args.output_csv)
        existing_df = existing_df.set_index("filename")
        final_df = new_results_df.combine_first(existing_df).reset_index()
    else:
        final_df = new_results_df.reset_index()

    if args.dry_run:
        print("\n--- DRY RUN REPORT ---")
        if args.update and not existing_df.empty:
            new_rows = final_df[~final_df["filename"].isin(list(existing_df.index))]
            print(f"Would add {len(new_rows)} new question rows.")
            print(f"Final CSV would have shape: {final_df.shape}")
            print("\nSample of final data:")
            print(final_df.head().to_string())
        else:
            print(f"Would create new CSV with shape: {final_df.shape}")
            print("\nSample of data:")
            print(final_df.head().to_string())
        print("\n--- END DRY RUN ---")
        return

    # Ensure filename is the first column
    cols = ["filename"] + [col for col in final_df.columns if col != "filename"]
    final_df = final_df[cols]

    final_df.to_csv(args.output_csv, index=False)
    print(f"Successfully saved all AI answers to {args.output_csv}")

    if args.cleanup:
        cleanup(tracker)


if __name__ == "__main__":
    main()
