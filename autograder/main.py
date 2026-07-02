import os
import shutil
import asyncio
import subprocess
import glob
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
from huggingface_hub import InferenceClient

# Setup Logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("autograder")

app = FastAPI(title="Antigravity LMS Autograder Engine")

# Enable CORS for frontend website access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Concurrency lock to sequentialize evaluations and prevent CPU overflow
grading_lock = asyncio.Lock()

class GradeRequest(BaseModel):
    student_id: str
    repo_url: str
    commit_hash: str
    apps_script_url: str

@app.get("/")
def read_root():
    return {"status": "online", "engine": "Verilator + Qwen2.5-Coder Evaluation Engine"}

@app.post("/grade-commit")
async def grade_commit(req: GradeRequest):
    # Acquire the lock to run evaluations sequentially
    async with grading_lock:
        logger.info(f"Starting autograde sequence for student {req.student_id}, commit {req.commit_hash}")
        
        target_dir = f"repo_{req.student_id}"
        verilator_logs = ""
        verilator_success = False
        ai_feedback = ""
        status = "PASSED"
        
        try:
            # 1. Cleanup pre-existing directory
            if os.path.exists(target_dir):
                shutil.rmtree(target_dir)
                
            # 2. Git Clone and Checkout specific commit
            clone_cmd = ["git", "clone", req.repo_url, target_dir]
            logger.info(f"Running command: {' '.join(clone_cmd)}")
            subprocess.run(clone_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            checkout_cmd = ["git", "-C", target_dir, "checkout", req.commit_hash]
            logger.info(f"Running command: {' '.join(checkout_cmd)}")
            subprocess.run(checkout_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # 3. Locate all Verilog (.v) and SystemVerilog (.sv) files in the cloned repository
            hw_files = []
            for ext in ("/**/*.v", "/**/*.sv"):
                hw_files.extend(glob.glob(target_dir + ext, recursive=True))
                
            if not hw_files:
                status = "FAILED"
                ai_feedback = "0/10 | Evaluation Error: No hardware files (.v or .sv) found in the repository."
                verilator_logs = "No source files found."
            else:
                logger.info(f"Discovered hardware files: {hw_files}")
                
                # 4. Compile check using Verilator
                compile_cmd = ["verilator", "--binary", "-Wall"] + hw_files
                logger.info(f"Running compiler: {' '.join(compile_cmd)}")
                
                proc = subprocess.run(compile_cmd, capture_output=True, text=True)
                verilator_logs = proc.stderr if proc.stderr else proc.stdout
                verilator_success = (proc.returncode == 0)
                
                # Truncate logs if excessively long
                if len(verilator_logs) > 5000:
                    verilator_logs = verilator_logs[:5000] + "\n... [truncated]"
                
                # 5. AI Grading evaluation (only if compilation passed, or fallback if failed)
                if not verilator_success:
                    status = "FAILED"
                    ai_feedback = "0/10 | Compilation failed. See syntax trace errors."
                else:
                    # Read code contents of discovered files for LLM prompt context
                    code_contents = []
                    for fpath in hw_files:
                        try:
                            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                                code_contents.append(f"// FILE: {os.path.basename(fpath)}\n" + f.read())
                        except Exception as e:
                            logger.error(f"Error reading file {fpath}: {str(e)}")
                    
                    code_context = "\n\n".join(code_contents)
                    if len(code_context) > 12000:
                        code_context = code_context[:12000] + "\n... [truncated]"
                    
                    # Call Hugging Face Serverless Inference API
                    hf_token = os.environ.get("HF_TOKEN")
                    if not hf_token:
                        raise ValueError("HF_TOKEN secret is missing in the environment.")
                        
                    client = InferenceClient(provider="hf-inference", token=hf_token)
                    
                    system_prompt = (
                        "You are an expert hardware design engineering professor. Evaluate the following Verilog/SystemVerilog "
                        "code submissions. Inspect the code for key structural design flaws:\n"
                        "1. Mixing blocking (=) and non-blocking (<=) assignments in sequential/combinational blocks.\n"
                        "2. Unintentional latches (incomplete if-else or case statements in combinational always blocks).\n"
                        "3. Race conditions and clock domain issues.\n\n"
                        "Your output must follow this format strictly:\n"
                        "[Score]/10 | [Feedback]\n"
                        "Example:\n"
                        "8/10 | Good structure, but always_comb block is missing a default case which might infer a latch."
                    )
                    
                    user_prompt = f"Submitter ID: {req.student_id}\n\nCode Files Content:\n{code_context}"
                    
                    logger.info("Requesting evaluation from Qwen LLM...")
                    response = client.chat.completions.create(
                        model="Qwen/Qwen2.5-Coder-7B-Instruct",
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ],
                        max_tokens=500
                    )
                    
                    ai_feedback = response.choices[0].message.content.strip()
                    logger.info(f"AI response received: {ai_feedback}")
                    
        except subprocess.CalledProcessError as git_err:
            logger.error(f"Git check/checkout failed: {str(git_err)}")
            status = "ERROR"
            ai_feedback = "0/10 | Git operation failed. Ensure the repo is public and the commit hash is correct."
            verilator_logs = f"Git error occurred."
        except Exception as err:
            logger.error(f"System evaluation error: {str(err)}")
            status = "ERROR"
            ai_feedback = f"0/10 | Autograding pipeline error: {str(err)}"
            verilator_logs = f"Error trace: {str(err)}"
        finally:
            # 6. Post-evaluation clean up to keep container storage at zero
            logger.info("Cleaning up workspace storage...")
            if os.path.exists(target_dir):
                shutil.rmtree(target_dir)
                
        # 7. Deliver callback back to Google Apps Script Web App
        callback_payload = {
            "action": "autogradingCallback",
            "student_id": req.student_id,
            "commit_hash": req.commit_hash,
            "status": status,
            "grading_output": ai_feedback,
            "compiler_logs": verilator_logs[:1000] # send first 1000 characters
        }
        
        logger.info(f"Delivering autograding callback to Apps Script: {callback_payload}")
        try:
            res = requests.post(req.apps_script_url, json=callback_payload, headers={"Content-Type": "text/plain"})
            logger.info(f"Callback status: {res.status_code}, Response: {res.text}")
        except Exception as cb_err:
            logger.error(f"Failed to post callback to Google Sheets backend: {str(cb_err)}")
            
        return {
            "success": True,
            "student_id": req.student_id,
            "status": status,
            "score_feedback": ai_feedback
        }
