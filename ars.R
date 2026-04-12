#!/usr/bin/env Rscript

# =============================================================================
# Adaptive Rejection Sampling (Gilks & Wild, 1992)
# =============================================================================
# Implements the ARS algorithm for sampling from log-concave distributions.
# The user provides an unnormalized density g(x); internally we work with
# h(x) = log(g(x)) and its derivative h'(x).
# =============================================================================


# --- Numerical derivative of h(x) = log(g(x)) ---
numerical_derivative <- function(h, x, eps = 1e-7) {
  (h(x + eps) - h(x - eps)) / (2 * eps)
}


# --- Compute intersection of two tangent lines ---
# Tangent at x_j: y = h(x_j) + h'(x_j)*(x - x_j)
# Tangent at x_{j+1}: y = h(x_{j+1}) + h'(x_{j+1})*(x - x_{j+1})
# Returns the x-coordinate where they meet.
tangent_intersection <- function(h_vals, hprime_vals, abscissae, j) {
  xj   <- abscissae[j]
  xj1  <- abscissae[j + 1]
  hj   <- h_vals[j]
  hj1  <- h_vals[j + 1]
  hpj  <- hprime_vals[j]
  hpj1 <- hprime_vals[j + 1]

  if (abs(hpj - hpj1) < 1e-15) {
    return((xj + xj1) / 2)
  }

  z <- (hj1 - hj - xj1 * hpj1 + xj * hpj) / (hpj - hpj1)
  return(z)
}


# --- Build the upper hull (piecewise linear envelope) ---
# Returns a list with:
#   z       - breakpoints (length k+1, including domain bounds)
#   slopes  - slope of each tangent piece
#   intercepts - intercept of each tangent piece (in the form h(xj) + h'(xj)*(x - xj))
build_upper_hull <- function(h_vals, hprime_vals, abscissae, domain) {
  k <- length(abscissae)
  # Interior breakpoints from tangent intersections
  z_interior <- numeric(k - 1)
  for (j in 1:(k - 1)) {
    z_interior[j] <- tangent_intersection(h_vals, hprime_vals, abscissae, j)
  }
  # Full breakpoints: domain[1], z_1, ..., z_{k-1}, domain[2]
  z <- c(domain[1], z_interior, domain[2])

  return(list(z = z, h_vals = h_vals, hprime_vals = hprime_vals, abscissae = abscissae))
}


# --- Evaluate the upper hull at a point x ---
eval_upper_hull <- function(x, hull) {
  z   <- hull$z
  k   <- length(hull$abscissae)

  # Find which piece x falls into
  # Piece j covers [z[j], z[j+1]] and uses tangent at abscissae[j]
  j <- findInterval(x, z)
  j <- pmax(1, pmin(j, k))  # clamp to valid range

  xj  <- hull$abscissae[j]
  hj  <- hull$h_vals[j]
  hpj <- hull$hprime_vals[j]

  return(hj + hpj * (x - xj))
}


# --- Evaluate the lower hull (squeezing function) at a point x ---
# The lower hull is the chord connecting (x_j, h(x_j)) to (x_{j+1}, h(x_{j+1}))
# for x in [x_j, x_{j+1}]. Undefined outside [x_1, x_k].
eval_lower_hull <- function(x, abscissae, h_vals) {
  k <- length(abscissae)
  if (k < 2) return(rep(-Inf, length(x)))

  result <- rep(-Inf, length(x))

  # For each x, find which interval [x_j, x_{j+1}] it belongs to
  j <- findInterval(x, abscissae)

  # Valid only for j in 1..(k-1), i.e., x in [x_1, x_k]
  valid <- (j >= 1) & (j < k)

  if (any(valid)) {
    jv <- j[valid]
    xv <- x[valid]
    # Linear interpolation between (abscissae[jv], h_vals[jv]) and (abscissae[jv+1], h_vals[jv+1])
    t <- (xv - abscissae[jv]) / (abscissae[jv + 1] - abscissae[jv])
    result[valid] <- (1 - t) * h_vals[jv] + t * h_vals[jv + 1]
  }

  return(result)
}


# --- Sample from the upper hull (piecewise exponential) ---
# Each piece j is an exponential-linear segment on [z[j], z[j+1]]:
#   u_j(x) = h(x_j) + h'(x_j)*(x - x_j)
# exp(u_j(x)) integrates to a known form.
sample_upper_hull <- function(n, hull) {
  z   <- hull$z
  k   <- length(hull$abscissae)
  abs <- hull$abscissae
  hv  <- hull$h_vals
  hpv <- hull$hprime_vals

  # Compute the integral of exp(u_j(x)) over each piece [z[j], z[j+1]]
  areas <- numeric(k)
  for (j in 1:k) {
    a <- z[j]
    b <- z[j + 1]
    slope <- hpv[j]
    intercept_at_xj <- hv[j]

    if (abs(slope) < 1e-15) {
      # Nearly flat: exp(c) * (b - a)
      val_at_xj <- intercept_at_xj + slope * ((a + b) / 2 - abs[j])
      areas[j] <- exp(val_at_xj) * (b - a)
    } else {
      # Integral of exp(c + slope*(x - xj)) from a to b
      # = exp(c) / slope * [exp(slope*(b-xj)) - exp(slope*(a-xj))]
      log_area <- intercept_at_xj - log(abs(slope))
      exp_b <- slope * (b - abs[j])
      exp_a <- slope * (a - abs[j])

      # Use log-sum-exp for numerical stability
      if (slope > 0) {
        areas[j] <- exp(log_area) * (exp(exp_b) - exp(exp_a))
      } else {
        areas[j] <- exp(log_area) * (exp(exp_a) - exp(exp_b))
      }
    }
  }

  # Handle any non-finite areas (shouldn't happen with valid log-concave density)
  areas[!is.finite(areas) | areas < 0] <- 0
  total_area <- sum(areas)

  if (total_area <= 0 || !is.finite(total_area)) {
    stop("Cannot sample from upper hull: total area is zero or non-finite.")
  }

  # Probability of each piece
  probs <- areas / total_area

  # Sample which piece each point comes from
  pieces <- sample(1:k, n, replace = TRUE, prob = probs)

  # Sample within each piece using inverse CDF
  samples <- numeric(n)
  for (i in 1:n) {
    j <- pieces[i]
    a <- z[j]
    b <- z[j + 1]
    slope <- hpv[j]

    if (abs(slope) < 1e-15) {
      # Uniform on [a, b]
      samples[i] <- runif(1, a, b)
    } else {
      # Inverse CDF of truncated exponential
      u <- runif(1)
      exp_a <- slope * (a - abs[j])
      exp_b <- slope * (b - abs[j])

      if (slope > 0) {
        # CDF(x) = [exp(slope*(x-xj)) - exp(slope*(a-xj))] / [exp(slope*(b-xj)) - exp(slope*(a-xj))]
        range_val <- exp(exp_b) - exp(exp_a)
        val <- exp_a + log(exp(exp_a) + u * range_val) # This is slope*(x - xj)
        # Actually: log(exp(exp_a) + u * range_val) but need to be careful
        target <- log(exp(exp_a) + u * (exp(exp_b) - exp(exp_a)))
        samples[i] <- abs[j] + target / slope
      } else {
        # slope < 0
        range_val <- exp(exp_a) - exp(exp_b)
        target <- log(exp(exp_a) - u * range_val)
        samples[i] <- abs[j] + target / slope
      }
    }

    # Clamp to interval (safety)
    samples[i] <- max(a, min(b, samples[i]))
  }

  return(samples)
}


# --- Check log-concavity: h'(x) must be non-increasing ---
check_log_concavity <- function(hprime_vals, abscissae) {
  k <- length(hprime_vals)
  if (k < 2) return(TRUE)

  for (i in 2:k) {
    if (hprime_vals[i] > hprime_vals[i - 1] + 1e-8) {
      return(FALSE)
    }
  }
  return(TRUE)
}


# --- Validate inputs ---
validate_inputs <- function(g, n, domain, x_init) {
  if (!is.function(g)) {
    stop("'g' must be a function computing the (unnormalized) density.")
  }
  if (!is.numeric(n) || length(n) != 1 || n < 1 || n != floor(n)) {
    stop("'n' must be a positive integer.")
  }
  if (!is.numeric(domain) || length(domain) != 2) {
    stop("'domain' must be a numeric vector of length 2: c(lower, upper).")
  }
  if (domain[1] >= domain[2]) {
    stop("'domain[1]' must be strictly less than 'domain[2]'.")
  }
  if (!is.null(x_init)) {
    if (!is.numeric(x_init) || length(x_init) < 2) {
      stop("'x_init' must be a numeric vector with at least 2 starting points.")
    }
    if (any(x_init <= domain[1]) || any(x_init >= domain[2])) {
      stop("All initial abscissae must be strictly within the domain.")
    }
    if (is.unsorted(x_init)) {
      x_init <- sort(x_init)
    }
  }

  # Test that g returns positive finite values at a few points
  test_pts <- if (!is.null(x_init)) x_init else {
    seq(domain[1] + 0.01 * (domain[2] - domain[1]),
        domain[2] - 0.01 * (domain[2] - domain[1]), length.out = 3)
  }
  test_vals <- g(test_pts)
  if (any(!is.finite(test_vals)) || any(test_vals <= 0)) {
    stop("Density function 'g' must return positive finite values within the domain.")
  }

  return(TRUE)
}


# --- Choose initial abscissae ---
choose_initial_abscissae <- function(h, hprime, domain, n_init = 5) {
  # Pick initial points spread across the domain
  if (is.infinite(domain[1]) && is.infinite(domain[2])) {
    # Both bounds infinite: use points around 0
    x_init <- seq(-3, 3, length.out = n_init)
  } else if (is.infinite(domain[1])) {
    x_init <- seq(domain[2] - 10, domain[2] - 0.5, length.out = n_init)
  } else if (is.infinite(domain[2])) {
    x_init <- seq(domain[1] + 0.5, domain[1] + 10, length.out = n_init)
  } else {
    margin <- (domain[2] - domain[1]) * 0.05
    x_init <- seq(domain[1] + margin, domain[2] - margin, length.out = n_init)
  }

  # Verify h is finite at all points
  h_vals <- sapply(x_init, h)
  good <- is.finite(h_vals)
  if (sum(good) < 2) {
    stop("Could not find valid initial abscissae where log-density is finite.")
  }
  x_init <- x_init[good]

  # For unbounded domains, need derivative constraints:
  # If lower bound is -Inf, leftmost point must have h'(x) > 0
  # If upper bound is +Inf, rightmost point must have h'(x) < 0
  hp_vals <- sapply(x_init, function(xi) hprime(xi))

  if (is.infinite(domain[1])) {
    # Ensure leftmost has positive derivative; try shifting left if needed
    attempts <- 0
    while (hp_vals[1] <= 0 && attempts < 20) {
      x_init[1] <- x_init[1] - 2
      hv <- h(x_init[1])
      if (!is.finite(hv)) break
      hp_vals[1] <- hprime(x_init[1])
      attempts <- attempts + 1
    }
    if (hp_vals[1] <= 0) {
      stop("Cannot find a left abscissa with positive derivative for unbounded left domain.")
    }
  }

  if (is.infinite(domain[2])) {
    k <- length(x_init)
    attempts <- 0
    while (hp_vals[k] >= 0 && attempts < 20) {
      x_init[k] <- x_init[k] + 2
      hv <- h(x_init[k])
      if (!is.finite(hv)) break
      hp_vals[k] <- hprime(x_init[k])
      attempts <- attempts + 1
    }
    if (hp_vals[k] >= 0) {
      stop("Cannot find a right abscissa with negative derivative for unbounded right domain.")
    }
  }

  return(sort(x_init))
}


# =============================================================================
# Main ARS function
# =============================================================================
#
# Arguments:
#   g       - Function computing the (possibly unnormalized) density. Must accept
#             a numeric vector and return positive values. (e.g., dnorm, dgamma)
#   n       - Number of samples to generate (positive integer).
#   domain  - Numeric vector c(lower, upper) for the support. Use -Inf/Inf for
#             unbounded. Default: c(-Inf, Inf).
#   x_init  - Optional numeric vector of initial abscissae (at least 2).
#             Must be strictly within domain. If NULL, chosen automatically.
#
# Returns:
#   A numeric vector of n samples from the distribution proportional to g.
#
ars <- function(g, n, domain = c(-Inf, Inf), x_init = NULL) {

  # --- Input validation ---
  validate_inputs(g, n, domain, x_init)

  # --- Define h(x) = log(g(x)) and its derivative ---
  h <- function(x) {
    val <- g(x)
    if (any(val <= 0, na.rm = TRUE)) return(rep(-Inf, length(x)))
    return(log(val))
  }

  hprime <- function(x) {
    numerical_derivative(h, x)
  }

  # --- Choose initial abscissae if not provided ---
  if (is.null(x_init)) {
    abscissae <- choose_initial_abscissae(h, hprime, domain)
  } else {
    abscissae <- sort(x_init)
  }

  # --- Evaluate h and h' at initial abscissae ---
  h_vals     <- sapply(abscissae, h)
  hprime_vals <- sapply(abscissae, hprime)

  # --- Initial log-concavity check ---
  if (!check_log_concavity(hprime_vals, abscissae)) {
    stop("Log-concavity violated at initial abscissae. The density may not be log-concave.")
  }

  # --- Sampling loop ---
  samples <- numeric(n)
  count <- 0
  max_iter <- n * 100  # safety limit
  iter <- 0

  while (count < n && iter < max_iter) {
    iter <- iter + 1

    # Build upper hull from current abscissae
    hull <- build_upper_hull(h_vals, hprime_vals, abscissae, domain)

    # Sample a candidate from the upper hull
    x_star <- sample_upper_hull(1, hull)

    # Evaluate upper and lower hulls at the candidate
    u_star <- eval_upper_hull(x_star, hull)
    l_star <- eval_lower_hull(x_star, abscissae, h_vals)

    # Uniform for acceptance test
    w <- runif(1)

    # Squeezing test
    if (w <= exp(l_star - u_star)) {
      # Accepted by squeezing function (no need to evaluate h)
      count <- count + 1
      samples[count] <- x_star
    } else {
      # Need to evaluate h at the candidate
      h_star <- h(x_star)
      hprime_star <- hprime(x_star)

      # Rejection test
      if (w <= exp(h_star - u_star)) {
        count <- count + 1
        samples[count] <- x_star
      }

      # --- Update abscissae with the new point ---
      insert_pos <- findInterval(x_star, abscissae) + 1

      abscissae   <- append(abscissae, x_star, after = insert_pos - 1)
      h_vals      <- append(h_vals, h_star, after = insert_pos - 1)
      hprime_vals <- append(hprime_vals, hprime_star, after = insert_pos - 1)

      # --- Log-concavity check after insertion ---
      if (!check_log_concavity(hprime_vals, abscissae)) {
        stop("Log-concavity violated after inserting a new point. The density is not log-concave.")
      }
    }
  }

  if (count < n) {
    warning(paste("Only generated", count, "out of", n, "requested samples."))
    samples <- samples[1:count]
  }

  return(samples)
}


# =============================================================================
# Test suite
# =============================================================================

test <- function() {
  cat("=============================================================\n")
  cat("  Adaptive Rejection Sampler - Test Suite\n")
  cat("=============================================================\n\n")

  pass_count <- 0
  fail_count <- 0

  report <- function(name, passed, details = "") {
    if (passed) {
      cat(sprintf("%s: PASS%s\n", name, ifelse(nchar(details) > 0, paste0(" -- ", details), "")))
      pass_count <<- pass_count + 1
    } else {
      cat(sprintf("%s: FAIL%s\n", name, ifelse(nchar(details) > 0, paste0(" -- ", details), "")))
      fail_count <<- fail_count + 1
    }
  }

  # ---------------------------------------------------------------
  # 1. Input validation tests
  # ---------------------------------------------------------------
  cat("--- Input Validation ---\n")

  # Negative n
  tryCatch({
    ars(dnorm, -5)
    report("Reject negative n", FALSE)
  }, error = function(e) {
    report("Reject negative n", TRUE, e$message)
  })

  # Non-integer n
  tryCatch({
    ars(dnorm, 3.5)
    report("Reject non-integer n", FALSE)
  }, error = function(e) {
    report("Reject non-integer n", TRUE, e$message)
  })

  # Invalid domain
  tryCatch({
    ars(dnorm, 100, domain = c(5, 2))
    report("Reject invalid domain (lower >= upper)", FALSE)
  }, error = function(e) {
    report("Reject invalid domain (lower >= upper)", TRUE, e$message)
  })

  # Non-function g
  tryCatch({
    ars("not_a_function", 100)
    report("Reject non-function density", FALSE)
  }, error = function(e) {
    report("Reject non-function density", TRUE, e$message)
  })

  # x_init outside domain
  tryCatch({
    ars(dnorm, 100, domain = c(-5, 5), x_init = c(-10, 0, 3))
    report("Reject x_init outside domain", FALSE)
  }, error = function(e) {
    report("Reject x_init outside domain", TRUE, e$message)
  })

  # Too few x_init
  tryCatch({
    ars(dnorm, 100, domain = c(-5, 5), x_init = c(0))
    report("Reject x_init with < 2 points", FALSE)
  }, error = function(e) {
    report("Reject x_init with < 2 points", TRUE, e$message)
  })

  cat("\n")

  # ---------------------------------------------------------------
  # 2. Log-concavity check
  # ---------------------------------------------------------------
  cat("--- Log-Concavity Detection ---\n")

  # Cauchy is not log-concave in the tails
  # A mixture of two normals with well-separated modes is not log-concave
  bimodal <- function(x) 0.5 * dnorm(x, -5, 0.5) + 0.5 * dnorm(x, 5, 0.5)
  tryCatch({
    ars(bimodal, 100, domain = c(-10, 10), x_init = c(-6, -4, 0, 4, 6))
    report("Detect non-log-concave bimodal", FALSE, "Should have thrown error")
  }, error = function(e) {
    is_concavity_err <- grepl("[Ll]og-concav", e$message)
    report("Detect non-log-concave bimodal", is_concavity_err,
           ifelse(is_concavity_err, "Correctly caught", paste("Wrong error:", e$message)))
  })

  cat("\n")

  # ---------------------------------------------------------------
  # 3. Standard Normal N(0,1)
  # ---------------------------------------------------------------
  cat("--- Standard Normal N(0,1) ---\n")

  set.seed(42)
  n_test <- 10000
  samples_norm <- ars(dnorm, n_test)

  # Write samples to file
  writeLines(as.character(samples_norm), "/app/normal_samples.txt")
  cat(sprintf("  (wrote %d samples to /app/normal_samples.txt)\n", length(samples_norm)))

  m <- mean(samples_norm)
  s <- sd(samples_norm)
  cat(sprintf("  Sample mean = %.4f, sd = %.4f (expected: 0, 1)\n", m, s))

  # KS test against N(0,1)
  ks <- ks.test(samples_norm, "pnorm")
  report("Normal: correct count", length(samples_norm) == n_test)
  report("Normal: mean within tolerance", abs(m) < 0.1,
         sprintf("mean=%.4f", m))
  report("Normal: sd within tolerance", abs(s - 1) < 0.15,
         sprintf("sd=%.4f", s))
  report("Normal: KS test (p > 0.01)", ks$p.value > 0.01,
         sprintf("p=%.4f", ks$p.value))

  cat("\n")

  # ---------------------------------------------------------------
  # 4. Exponential(1)
  # ---------------------------------------------------------------
  cat("--- Exponential(1) ---\n")

  set.seed(123)
  samples_exp <- ars(dexp, n_test, domain = c(0, Inf),
                     x_init = c(0.1, 1, 3, 5))

  writeLines(as.character(samples_exp), "/app/exponential_samples.txt")
  cat(sprintf("  (wrote %d samples to /app/exponential_samples.txt)\n", length(samples_exp)))

  m_exp <- mean(samples_exp)
  s_exp <- sd(samples_exp)
  cat(sprintf("  Sample mean = %.4f, sd = %.4f (expected: 1, 1)\n", m_exp, s_exp))

  ks_exp <- ks.test(samples_exp, "pexp")
  report("Exponential: correct count", length(samples_exp) == n_test)
  report("Exponential: mean within tolerance", abs(m_exp - 1) < 0.15,
         sprintf("mean=%.4f", m_exp))
  report("Exponential: sd within tolerance", abs(s_exp - 1) < 0.15,
         sprintf("sd=%.4f", s_exp))
  report("Exponential: KS test (p > 0.01)", ks_exp$p.value > 0.01,
         sprintf("p=%.4f", ks_exp$p.value))

  cat("\n")

  # ---------------------------------------------------------------
  # 5. Gamma(3, 1) - shape > 1 so it's log-concave
  # ---------------------------------------------------------------
  cat("--- Gamma(3,1) ---\n")

  set.seed(99)
  g_gamma <- function(x) dgamma(x, shape = 3, rate = 1)
  samples_gam <- ars(g_gamma, n_test, domain = c(0, Inf),
                     x_init = c(0.5, 1, 3, 6, 10))

  m_gam <- mean(samples_gam)
  s_gam <- sd(samples_gam)
  cat(sprintf("  Sample mean = %.4f, sd = %.4f (expected: 3, %.4f)\n",
              m_gam, s_gam, sqrt(3)))

  ks_gam <- ks.test(samples_gam, pgamma, shape = 3, rate = 1)
  report("Gamma: mean within tolerance", abs(m_gam - 3) < 0.3,
         sprintf("mean=%.4f", m_gam))
  report("Gamma: sd within tolerance", abs(s_gam - sqrt(3)) < 0.3,
         sprintf("sd=%.4f", s_gam))
  report("Gamma: KS test (p > 0.01)", ks_gam$p.value > 0.01,
         sprintf("p=%.4f", ks_gam$p.value))

  cat("\n")

  # ---------------------------------------------------------------
  # 6. Beta(2, 5) on (0, 1)
  # ---------------------------------------------------------------
  cat("--- Beta(2,5) ---\n")

  set.seed(77)
  g_beta <- function(x) dbeta(x, 2, 5)
  samples_beta <- ars(g_beta, n_test, domain = c(0, 1),
                      x_init = c(0.1, 0.3, 0.5, 0.7))

  m_beta <- mean(samples_beta)
  s_beta <- sd(samples_beta)
  expected_mean <- 2 / 7
  expected_sd <- sqrt(2 * 5 / (49 * 8))
  cat(sprintf("  Sample mean = %.4f, sd = %.4f (expected: %.4f, %.4f)\n",
              m_beta, s_beta, expected_mean, expected_sd))

  ks_beta <- ks.test(samples_beta, pbeta, 2, 5)
  report("Beta: mean within tolerance", abs(m_beta - expected_mean) < 0.1,
         sprintf("mean=%.4f", m_beta))
  report("Beta: KS test (p > 0.01)", ks_beta$p.value > 0.01,
         sprintf("p=%.4f", ks_beta$p.value))

  cat("\n")

  # ---------------------------------------------------------------
  # 7. Unnormalized density (proportional to Normal)
  # ---------------------------------------------------------------
  cat("--- Unnormalized density (proportional to N(3,4)) ---\n")

  set.seed(55)
  g_unnorm <- function(x) exp(-0.5 * ((x - 3) / 2)^2)  # unnormalized, sigma=2
  samples_un <- ars(g_unnorm, n_test,
                    x_init = c(-2, 0, 3, 6, 8))

  m_un <- mean(samples_un)
  s_un <- sd(samples_un)
  cat(sprintf("  Sample mean = %.4f, sd = %.4f (expected: 3, 2)\n", m_un, s_un))

  report("Unnormalized: mean within tolerance", abs(m_un - 3) < 0.2,
         sprintf("mean=%.4f", m_un))
  report("Unnormalized: sd within tolerance", abs(s_un - 2) < 0.3,
         sprintf("sd=%.4f", s_un))

  cat("\n")

  # ---------------------------------------------------------------
  # 8. Module tests: numerical derivative
  # ---------------------------------------------------------------
  cat("--- Module: numerical_derivative ---\n")

  h_test <- function(x) -0.5 * x^2  # h'(x) = -x
  d_at_2 <- numerical_derivative(h_test, 2)
  d_at_neg3 <- numerical_derivative(h_test, -3)
  report("Derivative at x=2 (expect -2)", abs(d_at_2 - (-2)) < 1e-5,
         sprintf("got %.6f", d_at_2))
  report("Derivative at x=-3 (expect 3)", abs(d_at_neg3 - 3) < 1e-5,
         sprintf("got %.6f", d_at_neg3))

  cat("\n")

  # ---------------------------------------------------------------
  # 9. Module tests: tangent intersection
  # ---------------------------------------------------------------
  cat("--- Module: tangent_intersection ---\n")

  # Two tangent lines of h(x) = -x^2 at x=1 and x=3
  # h(1) = -1, h'(1) = -2; h(3) = -9, h'(3) = -6
  # Intersection: -1 + (-2)(x-1) = -9 + (-6)(x-3)
  # -1 -2x +2 = -9 -6x +18 => 1 - 2x = 9 - 6x => 4x = 8 => x = 2
  z <- tangent_intersection(c(-1, -9), c(-2, -6), c(1, 3), 1)
  report("Tangent intersection (expect 2)", abs(z - 2) < 1e-10,
         sprintf("got %.6f", z))

  cat("\n")

  # ---------------------------------------------------------------
  # 10. Module tests: log-concavity checker
  # ---------------------------------------------------------------
  cat("--- Module: check_log_concavity ---\n")

  report("Decreasing slopes -> concave", check_log_concavity(c(3, 1, -1, -3), 1:4) == TRUE)
  report("Increasing slope -> not concave", check_log_concavity(c(-1, 2, -3), 1:3) == FALSE)

  cat("\n")

  # ---------------------------------------------------------------
  # Summary
  # ---------------------------------------------------------------
  cat("=============================================================\n")
  cat(sprintf("  Results: %d PASSED, %d FAILED out of %d total\n",
              pass_count, fail_count, pass_count + fail_count))
  cat("=============================================================\n")
}


# Run tests if executed as a script
if (!interactive() && identical(commandArgs(trailingOnly = FALSE)[1], "ars.R") == FALSE) {
  # Only auto-run when sourced directly
}
