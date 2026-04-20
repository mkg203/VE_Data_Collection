import argparse
import json
import os
import re

import pandas as pd
from dotenv import load_dotenv

try:
    from google import genai
    
except ImportError:
    print(
        "Error: The google-genai library is not installed. Please run `uv add google-genai`."
    )
    exit(1)

# Configuration
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

UPLOADTHING_DIR = os.path.join(PROJECT_ROOT, "uploadthing")

MODEL_NAME = "gemini-robotics-er-1.6-preview"
MODEL_KEY = "gemini-robotics"


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


def download_robotics_outputs(job_id, args, client):
    print(f"Checking Google AI Batch Job: {job_id}")
    try:
        job = client.batches.get(name=job_id)
    except Exception as e:
        print(f"Failed to get job: {e}")
        return []

    # Job states in genai are typically returned as strings
    state = getattr(job, "state", str(job))

    if (
        "RUNNING" in str(state).upper()
        or "PROCESSING" in str(state).upper()
        or "SCHEDULING" in str(state).upper()
    ):
        print(f"{MODEL_KEY} is still running (State: {state}).")
        return None
    if "SUCCEEDED" not in str(state).upper() and "COMPLETED" not in str(state).upper():
        print(f"{MODEL_KEY} failed or was cancelled. State: {state}")
        return []

    print(f"{MODEL_KEY} completed. Downloading results...")

    # We need to get the download URI from the job details
    result_file_name = getattr(job.dest, "file_name", None)
    if not result_file_name:
        # Sometimes it's output_uri
        result_file_name = getattr(job, "output_uri", None)

    if not result_file_name:
        print(
            "Warning: Could not find output file name on job object. Checking files..."
        )
        return []

    results, raw_outputs = [], []
    try:
        print(f"Downloading from {result_file_name}")
        # Use client to download file by its URI/Name
        file_bytes = client.files.download(file=result_file_name)
        content = file_bytes.decode("utf-8")

        for line in content.split("\n"):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                raw_outputs.append(data)

                # Check for error in response
                if "error" in data:
                    print(f"Error in response for line: {data['error']}")
                    continue

                # Look for the request object to get the original prompt (fallback method)
                req = data.get("request", {})
                if not req:
                    # Let's check if the request was passed inside another key
                    pass

                resp = data.get("response", {})

                # Try to get custom_id
                custom_id = data.get("key")
                if not custom_id:
                    print(
                        "Warning: Missing 'key' in response data. Cannot link answer directly."
                    )
                    # The response object doesn't contain the prompt.
                    # And 'request' is completely missing from this raw output format!
                    # This means if 'key' isn't there, we are blind.
                    # Wait, look at the snippet:
                    # "{"key": "request-1", "request": {"contents": ..."
                    # The batch job output *only* returns the response! It does NOT return the request object or the 'key'
                    # unless they are explicitly at the top level of the returned JSONL.
                    # Actually, looking at the raw output, it is exactly: `{"response": {...}}`. The `key` and `request` are dropped.
                    print(
                        "Could not find a way to link this answer to the original question."
                    )
                    continue

                answer_text = ""
                # Safely extract text
                if "candidates" in resp and resp["candidates"]:
                    content_part = resp["candidates"][0].get("content", {})
                    if "parts" in content_part and content_part["parts"]:
                        # The new genai SDK response has thoughtSignature and text inside parts
                        # We just want the final text output
                        for part in content_part["parts"]:
                            if "text" in part:
                                answer_text = part["text"]
                                break

                filename = custom_id.split("|", 1)[0]
                res = process_results(filename, answer_text, MODEL_KEY)
                if res:
                    results.append(res)
            except Exception as e:
                print(f"Error parsing line for {MODEL_KEY}: {e}")

    except Exception as e:
        print(f"Failed to download or parse output: {e}")

    if args.save_raw_output:
        save_bulk_raw_output(raw_outputs, MODEL_KEY, args.raw_output_dir)
    return results


def cleanup(tracker, client):
    print("Cleaning up cloud resources...")
    if f"{MODEL_KEY}_input_file_name" in tracker:
        file_name = tracker[f"{MODEL_KEY}_input_file_name"]
        try:
            client.files.delete(name=file_name)
            print(f"Deleted Google AI file: {file_name}")
        except Exception as e:
            print(f"Could not delete Google AI file {file_name}: {e}")


def main():
    parser = argparse.ArgumentParser(
        description=f"Download and process batch inference results for {MODEL_NAME}."
    )
    parser.add_argument(
        "--tracker-file",
        type=str,
        default=os.path.join(os.path.dirname(__file__), "robotics_batch_tracker.json"),
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

    api_key = os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print(
            "Error: GOOGLE_AI_API_KEY environment variable is not set. This is required for the Gemini API."
        )
        return

    if not os.path.exists(args.tracker_file):
        print(f"Tracker file not found at {args.tracker_file}.")
        return

    with open(args.tracker_file, "r") as f:
        tracker = json.load(f)

    job_id = tracker.get(f"{MODEL_KEY}_job_id")
    if not job_id:
        print(f"No job ID found in tracker for {MODEL_KEY}")
        return

    client = genai.Client(api_key=api_key)

    all_results = download_robotics_outputs(job_id, args, client)

    if all_results is None:
        print("Jobs are not finished yet.")
        return

    all_results_dict = {}
    if all_results:
        for item in all_results:
            fname = item["filename"]
            if fname not in all_results_dict:
                all_results_dict[fname] = {}
            all_results_dict[fname].update(item)

    if not all_results_dict:
        print("No results parsed.")
        return

    new_results_df = pd.DataFrame(list(all_results_dict.values())).set_index("filename")

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
        cleanup(tracker, client)


if __name__ == "__main__":
    main()
